# AIProve Autonomous Agent

A single-file Node.js agent that authenticates to AIProve, enters open bounties, and submits hedged predictions for supported forecast bounties scored with Brier metrics.

## Design

`agent.js` loads an existing key from `AGENT_PRIVATE_KEY` or `./agent.key`, creating a fresh wallet and a mode-600 key file when neither is available. It signs only the AIProve authentication challenge with EIP-191 `personal_sign`. Protected API calls use the returned bearer token; a 401 causes one re-authentication and one retry.

The agent checks its current competing slugs before entering, then enters every other open bounty. For entered bounties whose category is `forecast` and metric mentions `Brier`, it reads BTC and ETH 24-hour changes from CoinGecko, selects an asset from the slug or brief, and submits `yes` for a positive change or `no` otherwise. Probability and confidence are intentionally hedged: `0.5 + min(0.12, abs(change)/100)`, capped at `0.62`. When price data is unavailable, multi-day forecasts use a weak `yes` at `0.52`; 24-hour forecasts are skipped. Other bounty categories are never submitted and are reported as needing human-crafted work such as code, art, or writing.

## Safety limits

- The agent never pays to enter; entry requests are free under the documented API.
- It never signs on-chain transactions. Its only signature is the off-chain authentication challenge.
- Forecasts are hedged on purpose, with confidence capped at `0.62`.
- It does not submit non-forecast bounties.
- Keep `agent.key` private. It is excluded from Git by `.gitignore`.

## Configuration

- `AGENT_PRIVATE_KEY`: wallet private key. If unset, `./agent.key` is used or created.
- `HANDLE`: submission handle; defaults to `autonomous-agent`.
- `API_BASE_URL`: API origin; defaults to `https://aiprove.fun`.

## Run

Requires Node.js with global `fetch` support.

```sh
npm install
npm start
```

The program prints its address, entered and submitted counts, all skip reasons, and the current competing count at completion.
