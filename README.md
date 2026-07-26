# PoolTogether V5 Claimer Bot (Base)

Earns **claimer fees** by claiming PoolTogether V5 prizes on behalf of winners
on the Base network. Winners receive their prizes automatically; the bot gets
paid a small fee per prize claimed. Fees accumulate in the PrizePool contract
and are swept to your wallet on demand.

Validated live against Base mainnet (draw #799): contract ABIs, subgraph,
winner computation and fee math are all tested working.

## Honest expectations

- Fees are **fractions of a cent to a few cents per claim**. This is a
  learning project that can pay for its own gas, not an income stream.
- You are **racing professional bots**. If they claim first, your transaction
  reverts and you lose the gas (~$0.01-0.03 on Base). Expect that to happen.
- Maximum possible loss = whatever ETH you fund the bot wallet with.
  Start with $1-5 and treat it as tuition.

## How it works

1. `getPrizePoolInfo` reads the current draw state from the PrizePool.
2. Vaults are pulled from the official PoolTogether Base subgraph and filtered
   by TVL (default: >= $1,000 in recognized assets).
3. Depositor accounts are loaded from the subgraph (top N by balance).
4. Winners are computed on-chain via batched `isWinner` multicalls, then
   cross-checked against `wasClaimed` so we never pay gas on claimed prizes.
5. For each vault/tier group: expected fees (`computeFeePerClaim`) are compared
   against estimated gas; the bot claims only when the margin exceeds
   `MIN_MARGIN_PCT`. A `minFeePerClaim` of 95% of the quote protects against
   VRGDA fee decay between simulation and execution.
6. Fees pile up under your address in the PrizePool (`rewardBalance`); sweep
   them with `node bot.js sweep` (`withdrawRewards`).

## Setup

```bash
cd pooltogether-claimer-bot
npm install
cp .env.example .env
```

Edit `.env`:

1. Create a **fresh burner wallet** (e.g. new account in MetaMask, export key).
   Never use your main wallet.
2. Fund it with **$1-5 of ETH on Base** (buy on an exchange and withdraw to
   Base, or bridge). This is only for gas.
3. Paste the key into `PRIVATE_KEY`.
4. Leave `DRY_RUN=true` for now.

## Usage

```bash
node bot.js scan    # dry-run report: what it found and what it would do
node bot.js claim   # one live cycle (set DRY_RUN=false first)
node bot.js loop    # run forever, one cycle every LOOP_MINUTES
node bot.js sweep   # withdraw accumulated fees to your wallet
node bot.js         # same as scan
```

Every action is appended to `stats.log` (JSON lines) so you can tally
gas spent vs fees earned.

## Timing notes

- Prizes can only be claimed **after a draw is awarded and before it finalizes**
  (~24h window, daily draws). If the bot logs "draw finalized", claims reopen
  when the next draw is awarded — `loop` mode handles this by itself.
- Claimer fees **ramp up over the draw** (VRGDA). Claiming late in the draw
  pays more per claim but risks other bots beating you or the draw closing.

## Tuning

- `TIERS`: canary tiers (5,6) have 1024+4096 prize indices and dominate scan
  cost. Tiers 0-3 are cheap to scan but rarely win. Default scans all.
- `MAX_ACCOUNTS`: full scan of the main USDC vault = ~1,100 depositors x 5,461
  prize indices. On the public RPC that's very slow; with 250 it takes a few
  minutes. A free Alchemy/QuickNode RPC key speeds this up a lot.
- `MAX_CLAIMS_PER_TX`: bigger batches amortize gas but risk one bad prize
  reverting the whole batch (the Claimer skips failures gracefully, so this
  is mostly about gas efficiency).

## Running 24/7 on a VPS

```bash
# simple: tmux
tmux new -s bot
node bot.js loop
# detach with Ctrl+B, D

# or systemd (/etc/systemd/system/ptbot.service)
[Unit]
Description=PoolTogether claimer bot
After=network.target

[Service]
WorkingDirectory=/opt/pooltogether-claimer-bot
ExecStart=/usr/bin/node bot.js loop
Restart=always
EnvironmentFile=/opt/pooltogether-claimer-bot/.env

[Install]
WantedBy=multi-user.target
```

## Safety checklist

- [ ] Fresh wallet, $1-5 max
- [ ] `.env` never committed/shared (it's in .gitignore)
- [ ] `DRY_RUN=true` until you've watched a few `scan` cycles
- [ ] Sweep profits out regularly; don't let the bot wallet grow
- [ ] Verify addresses yourself: base-contracts.json is the official
      Generation Software deployment blob (PrizePool 0x45b2...32cb,
      Claimer 0xcdCE...47ba) - cross-check with dev.pooltogether.com

## Files

- `bot.js` - the whole bot (scan/claim/loop/sweep)
- `base-contracts.json` - official PoolTogether V5 Base contract ABIs/addresses
- `.env.example` - all configuration options, commented
- `stats.log` - created at runtime, JSON-lines activity log
