/**
 * PoolTogether V5 claimer bot (Base).
 *
 * What it does:
 *   1. Finds unclaimed prizes for the last awarded draw (subgraph + on-chain isWinner)
 *   2. Claims them via the Claimer contract, naming your wallet as fee recipient
 *   3. Sweeps accumulated fees out of the PrizePool on demand
 *
 * Commands:
 *   node bot.js scan    - dry-run report: winners found, fees, gas, profitability
 *   node bot.js claim   - one claim cycle (respects DRY_RUN)
 *   node bot.js loop    - repeat claim cycle every LOOP_MINUTES
 *   node bot.js sweep   - withdraw accumulated claimer fees to your wallet
 *
 * Contract addresses are the official PoolTogether V5 Base deployment,
 * loaded from the bundled base-contracts.json (Generation Software release blob).
 */
require('dotenv').config();
const fs = require('fs');
const { providers, Wallet, Contract, utils, BigNumber } = require('ethers');
const u = require('@generationsoftware/pt-v5-utils-js');

// ---------- Config ----------
const env = (k, d = '') => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const CFG = {
  rpc: env('RPC_URL', 'https://mainnet.base.org'),
  privateKey: env('PRIVATE_KEY'),
  dryRun: env('DRY_RUN', 'true').toLowerCase() !== 'false',
  feeRecipient: env('FEE_RECIPIENT'),
  loopMinutes: Number(env('LOOP_MINUTES', '10')),
  minMarginPct: Number(env('MIN_MARGIN_PCT', '25')),
  maxClaimsPerTx: Number(env('MAX_CLAIMS_PER_TX', '50')),
  tiers: env('TIERS', '0,1,2,3,4,5,6').split(',').map(Number),
  maxAccounts: Number(env('MAX_ACCOUNTS', '250')),
  minVaultTvlUsd: Number(env('MIN_VAULT_TVL_USD', '1000')),
  ethPriceUsd: Number(env('ETH_PRICE_USD', '3500')),
  sweepMinWeth: env('SWEEP_MIN_WETH', '0.0001'),
};
const SUBGRAPH = 'https://api.studio.thegraph.com/query/41211/pt-v5-base/version/latest';
const BLOB = require('./base-contracts.json'); // { name, version, timestamp, contracts: [...] }
const STATS_FILE = './stats.log';
const ERC4626_ABI = [
  'function symbol() view returns (string)',
  'function asset() view returns (address)',
  'function totalAssets() view returns (uint256)',
  'function decimals() view returns (uint8)',
];
// Recognized assets for TVL filtering (Base mainnet, lowercase)
const ASSET_USD = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', usd: 1 },
  '0x04c0599ae5a44757c0af6f9ec3b93da8976c150a': { symbol: 'EURC', usd: 1.1 },
  '0x4200000000000000000000000000000000000006': { symbol: 'WETH', usd: CFG.ethPriceUsd },
  '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452': { symbol: 'wstETH', usd: CFG.ethPriceUsd * 1.2 },
  '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': { symbol: 'cbETH', usd: CFG.ethPriceUsd * 1.1 },
};

const provider = new providers.JsonRpcProvider(CFG.rpc, 8453);
const wallet = CFG.privateKey
  ? new Wallet(CFG.privateKey.startsWith('0x') ? CFG.privateKey : '0x' + CFG.privateKey, provider)
  : null;
const feeRecipient = CFG.feeRecipient || (wallet && wallet.address);

const prizePoolBlob = BLOB.contracts.find(c => c.type === 'PrizePool');
const claimerBlob = BLOB.contracts.find(c => c.type === 'Claimer');
const prizePool = new Contract(prizePoolBlob.address, prizePoolBlob.abi, provider);
const claimer = new Contract(claimerBlob.address, claimerBlob.abi, wallet || provider);

const logStats = obj =>
  fs.appendFileSync(STATS_FILE, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
const fmt = wei => Number(utils.formatEther(wei));

// ---------- Step 1: prize pool state ----------
async function getPoolState() {
  const info = await u.getPrizePoolInfo(provider, BLOB);
  const scoped = {
    ...info,
    tiersRangeArray: CFG.tiers,
    numPrizeIndices: CFG.tiers.reduce((s, t) => s + 4 ** t, 0),
  };
  return scoped;
}

// ---------- Step 2: pick vaults ----------
async function pickVaults() {
  const vaults = await u.getSubgraphPrizeVaults(SUBGRAPH);
  const picked = [];
  for (const v of vaults) {
    try {
      const vc = new Contract(v.id, ERC4626_ABI, provider);
      const [asset, tvlRaw, dec, symbol] = await Promise.all([
        vc.asset(), vc.totalAssets(), vc.decimals(), vc.symbol().catch(() => '?'),
      ]);
      const meta = ASSET_USD[asset.toLowerCase()];
      const tvl = Number(utils.formatUnits(tvlRaw, dec));
      const tvlUsd = meta ? tvl * meta.usd : 0;
      if (meta && tvlUsd >= CFG.minVaultTvlUsd) {
        picked.push({ id: v.id, symbol, asset: meta.symbol, tvlUsd, accounts: [] });
        console.log(`  vault ${symbol} (${meta.symbol}) TVL ~$${Math.round(tvlUsd).toLocaleString()} -> scanning`);
      }
    } catch (e) { /* not a standard ERC4626 vault, skip */ }
  }
  if (picked.length === 0) console.log('  no vaults passed the TVL filter');
  return picked;
}

// ---------- Step 3: accounts ----------
async function populateAccounts(info, vaults) {
  const maxTierPeriod = info.drawPeriodSeconds * info.grandPrizePeriodDraws;
  const start = info.lastDrawClosedAt - maxTierPeriod;
  for (const v of vaults) {
    const [populated] = await u.populateSubgraphPrizeVaultAccounts(SUBGRAPH, [v], start, info.lastDrawClosedAt);
    let accounts = populated.accounts || [];
    accounts.sort((a, b) => Number(b.balance || 0) - Number(a.balance || 0));
    v.accounts = accounts.slice(0, CFG.maxAccounts);
    console.log(`  ${v.symbol}: ${accounts.length} depositors, scanning top ${v.accounts.length}`);
  }
  return vaults.filter(v => v.accounts.length > 0);
}

// ---------- Step 4: find winners & claim ----------
async function runCycle() {
  console.log('\n=== cycle @', new Date().toISOString(), CFG.dryRun ? '(DRY RUN)' : '(LIVE)', '===');
  const info = await getPoolState();
  console.log(`draw #${info.drawId} | tiers ${CFG.tiers.join(',')} | finalized: ${info.isDrawFinalized}`);
  if (info.isDrawFinalized) {
    console.log('claim period for last draw is over (draw finalized). Waiting for next draw award.');
    logStats({ event: 'skip_finalized', draw: info.drawId.toString() });
    return;
  }

  let vaults = await pickVaults();
  vaults = await populateAccounts(info, vaults);
  if (vaults.length === 0) { console.log('nothing to scan.'); return; }

  console.log('computing winners on-chain (this is the slow part)...');
  let claims = await u.getWinnersClaims(provider, info, BLOB, vaults);
  claims = await u.flagClaimedRpc(provider, BLOB, claims);
  const unclaimed = claims.filter(c => !c.claimed);
  console.log(`winners found: ${claims.length} | already claimed: ${claims.length - unclaimed.length} | unclaimed: ${unclaimed.length}`);
  logStats({ event: 'scan', draw: info.drawId.toString(), winners: claims.length, unclaimed: unclaimed.length });
  if (unclaimed.length === 0) return;

  // group by vault + tier
  const groups = {};
  for (const c of unclaimed) {
    const k = `${c.vault}|${c.tier}`;
    (groups[k] = groups[k] || []).push(c);
  }

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice || (await provider.getGasPrice());

  for (const [key, group] of Object.entries(groups)) {
    const [vaultAddr, tierStr] = key.split('|');
    const tier = Number(tierStr);
    // chunk into batches of MAX_CLAIMS_PER_TX
    for (let i = 0; i < group.length; i += CFG.maxClaimsPerTx) {
      const batch = group.slice(i, i + CFG.maxClaimsPerTx);
      const winners = batch.map(c => c.winner);
      const prizeIndices = batch.map(c => [c.prizeIndex]);
      await maybeClaim(vaultAddr, tier, winners, prizeIndices, gasPrice, info.drawId);
    }
  }
}

async function maybeClaim(vaultAddr, tier, winners, prizeIndices, gasPrice, drawId) {
  const n = winners.length;
  const feePerClaim = await claimer.computeFeePerClaim(tier, n);
  const expectedFees = feePerClaim.mul(n);

  let gasLimit;
  if (wallet) {
    try {
      gasLimit = await claimer.estimateGas.claimPrizes(
        vaultAddr, tier, winners, prizeIndices, feeRecipient, 0, { from: wallet.address });
    } catch (e) {
      console.log(`  [tier ${tier}] gas estimate failed (${e.error ? e.error.message : e.message.slice(0, 80)}), skipping batch`);
      return;
    }
  } else {
    gasLimit = BigNumber.from(150000 + 60000 * n); // rough fallback when no key configured
  }
  const gasCost = gasLimit.mul(gasPrice);
  const profit = expectedFees.sub(gasCost);
  const marginPct = gasCost.gt(0) ? profit.mul(100).div(gasCost).toNumber() : 0;

  console.log(
    `  [tier ${tier}] ${n} prize(s) @ ${vaultAddr.slice(0, 10)}... | fees ${fmt(expectedFees).toFixed(8)} WETH ` +
    `(${(fmt(expectedFees) * CFG.ethPriceUsd).toFixed(4)}) | gas ${fmt(gasCost).toFixed(8)} WETH | margin ${marginPct}%`);

  logStats({ event: 'evaluate', draw: drawId.toString(), vault: vaultAddr, tier, count: n,
    feesWei: expectedFees.toString(), gasWei: gasCost.toString(), marginPct });

  if (!wallet || !feeRecipient) { console.log('    no PRIVATE_KEY configured - cannot claim'); return; }
  if (profit.lte(0) || marginPct < CFG.minMarginPct) { console.log('    not profitable enough, skipping'); return; }

  // protect against VRGDA fee decay between simulation and execution
  const minFeePerClaim = feePerClaim.mul(95).div(100);

  if (CFG.dryRun) { console.log('    DRY RUN - would claim now'); return; }

  try {
    const tx = await claimer.claimPrizes(vaultAddr, tier, winners, prizeIndices, feeRecipient, minFeePerClaim);
    console.log('    tx sent:', tx.hash);
    const receipt = await tx.wait();
    const actualGas = receipt.gasUsed.mul(receipt.effectiveGasPrice);
    console.log(`    confirmed in block ${receipt.blockNumber} | gas used ${fmt(actualGas).toFixed(8)} WETH`);
    logStats({ event: 'claimed', draw: drawId.toString(), vault: vaultAddr, tier, count: n,
      tx: tx.hash, gasWei: actualGas.toString(), feesWei: expectedFees.toString() });
  } catch (e) {
    console.log('    claim tx failed:', (e.error && e.error.message) || e.message.slice(0, 120));
    logStats({ event: 'claim_failed', draw: drawId.toString(), vault: vaultAddr, tier, count: n,
      error: e.message.slice(0, 200) });
  }
}

// ---------- Sweep accumulated fees ----------
async function sweep() {
  if (!wallet) { console.log('no PRIVATE_KEY configured'); return; }
  const bal = await prizePool.rewardBalance(wallet.address);
  console.log(`claimer fee balance: ${fmt(bal).toFixed(8)} WETH ($${(fmt(bal) * CFG.ethPriceUsd).toFixed(4)})`);
  if (bal.lt(utils.parseEther(CFG.sweepMinWeth))) { console.log('below sweep threshold, leaving it'); return; }
  if (CFG.dryRun) { console.log('DRY RUN - would withdrawRewards'); return; }
  const tx = await prizePool.connect(wallet).withdrawRewards(wallet.address, bal);
  console.log('sweep tx:', tx.hash);
  await tx.wait();
  console.log('swept.');
  logStats({ event: 'swept', amountWei: bal.toString() });
}

// ---------- Main ----------
(async () => {
  const cmd = process.argv[2] || 'scan';
  if (wallet) console.log('wallet:', wallet.address, '| fee recipient:', feeRecipient);
  if (cmd === 'scan') { CFG.dryRun = true; await runCycle(); }
  else if (cmd === 'claim') { await runCycle(); }
  else if (cmd === 'sweep') { await sweep(); }
  else if (cmd === 'loop') {
    await runCycle();
    setInterval(() => runCycle().catch(e => console.error('cycle error:', e.message)), CFG.loopMinutes * 60 * 1000);
  } else {
    console.log('usage: node bot.js [scan|claim|loop|sweep]');
  }
})().catch(e => { console.error('fatal:', e); process.exit(1); });
