#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import { Wallet } from 'ethers';

const API_BASE_URL = (process.env.API_BASE_URL || 'https://aiprove.fun').replace(/\/$/, '');
const HANDLE = process.env.HANDLE || 'autonomous-agent';
const KEY_PATH = new URL('./agent.key', import.meta.url);
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true';

async function getWallet() {
  if (process.env.AGENT_PRIVATE_KEY) return new Wallet(process.env.AGENT_PRIVATE_KEY);
  try {
    const key = (await fs.readFile(KEY_PATH, 'utf8')).trim();
    return new Wallet(key);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const wallet = Wallet.createRandom();
    await fs.writeFile(KEY_PATH, `${wallet.privateKey}\n`, { mode: 0o600, flag: 'wx' });
    await fs.chmod(KEY_PATH, 0o600);
    console.log(`Created a new wallet key at ${KEY_PATH.pathname}`);
    return wallet;
  }
}

async function responseJson(response) {
  const body = await response.text();
  let data;
  try { data = body ? JSON.parse(body) : {}; } catch { data = { message: body }; }
  if (!response.ok) {
    const error = new Error(`${response.status} ${response.statusText}: ${data.message || data.error || body || 'request failed'}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function authenticate(wallet) {
  const challengeData = await responseJson(await fetch(`${API_BASE_URL}/api/auth/challenge?address=${encodeURIComponent(wallet.address)}`));
  if (!challengeData.challenge) throw new Error('Challenge response did not include challenge');
  const signature = await wallet.signMessage(challengeData.challenge);
  const verified = await responseJson(await fetch(`${API_BASE_URL}/api/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: wallet.address, signature }),
  }));
  if (!verified.token) throw new Error('Verify response did not include token');
  return verified.token;
}

// All protected requests share one retry path; a 401 refreshes auth exactly once.
async function apiRequest(path, options, wallet, auth) {
  const send = (token) => fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: { ...(options?.headers || {}), Authorization: `Bearer ${token}` },
  });
  let response = await send(auth.token);
  if (response.status === 401) {
    auth.token = await authenticate(wallet);
    response = await send(auth.token);
  }
  return responseJson(response);
}

function competingSlugs(me) {
  const values = me.competing ?? me.competitions ?? me.entries ?? [];
  return new Set(values.map((item) => typeof item === 'string' ? item : item.slug).filter(Boolean));
}

function isBrierForecast(bounty) {
  return String(bounty.cat || '').toLowerCase() === 'forecast'
    && /brier/i.test(String(bounty.metric || ''));
}

function getAsset(bounty) {
  const text = `${bounty.slug || ''} ${bounty.brief || ''}`.toLowerCase();
  const btc = /\b(btc|bitcoin)\b/.test(text);
  const eth = /\b(eth|ethereum)\b/.test(text);
  if (btc === eth) return null;
  return btc ? 'bitcoin' : 'ethereum';
}

function is24HourHorizon(bounty) {
  return /\b(24\s*[- ]?hours?|24h|1\s*day|daily)\b/i.test(`${bounty.slug || ''} ${bounty.title || ''} ${bounty.brief || ''} ${bounty.metric || ''}`);
}

async function fetchChanges() {
  const response = await fetch(COINGECKO_URL);
  const data = await responseJson(response);
  return {
    bitcoin: Number(data.bitcoin?.usd_24h_change),
    ethereum: Number(data.ethereum?.usd_24h_change),
  };
}

async function main() {
  const wallet = await getWallet();
  const auth = { token: await authenticate(wallet) };
  const skipped = [];
  let enteredCount = 0;
  let submittedCount = 0;

  const bountyResponse = await apiRequest('/api/bounties?status=open', {}, wallet, auth);
  const bounties = Array.isArray(bountyResponse) ? bountyResponse : (bountyResponse.bounties || []);
  const me = await apiRequest('/api/me', {}, wallet, auth);
  const competing = competingSlugs(me);
  for (const bounty of bounties) {
    if (!bounty.slug) {
      skipped.push({ slug: '(unknown)', reason: 'bounty response has no slug' });
      continue;
    }
    if (competing.has(bounty.slug)) continue;
    try {
      await apiRequest(`/api/bounties/${encodeURIComponent(bounty.slug)}/enter`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: HANDLE }),
      }, wallet, auth);
      enteredCount++;
      competing.add(bounty.slug);
      console.log(`Entered ${bounty.slug}`);
    } catch (error) {
      skipped.push({ slug: bounty.slug, reason: `entry failed: ${error.message}` });
    }
  }

  let changes;
  let changeFetchFailed = false;
  for (const bounty of bounties) {
    if (!competing.has(bounty.slug)) continue;
    if (!isBrierForecast(bounty)) {
      skipped.push({ slug: bounty.slug, reason: 'non-forecast bounty requires human-crafted code, art, or writing' });
      continue;
    }
    const asset = getAsset(bounty);
    if (!asset) {
      skipped.push({ slug: bounty.slug, reason: 'cannot determine BTC or ETH asset from slug/brief' });
      continue;
    }
    let prediction;
    if (!changes && !changeFetchFailed) {
      try { changes = await fetchChanges(); }
      catch (error) {
        changeFetchFailed = true;
        console.error(`CoinGecko price fetch failed: ${error.message}`);
      }
    }
    if (changes && Number.isFinite(changes[asset])) {
      const change = changes[asset];
      const prob = Math.min(0.62, 0.5 + Math.min(0.12, Math.abs(change) / 100));
      prediction = { answer: change > 0 ? 'yes' : 'no', prob, confidence: prob };
    } else if (is24HourHorizon(bounty)) {
      skipped.push({ slug: bounty.slug, reason: '24h price data unavailable; skipped forecast' });
      continue;
    } else {
      prediction = { answer: 'yes', prob: 0.52, confidence: 0.52 };
    }
    try {
      await apiRequest(`/api/bounties/${encodeURIComponent(bounty.slug)}/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prediction, handle: HANDLE }),
      }, wallet, auth);
      submittedCount++;
      console.log(`Submitted ${bounty.slug}: ${JSON.stringify(prediction)}`);
    } catch (error) {
      skipped.push({ slug: bounty.slug, reason: `submission failed: ${error.message}` });
    }
  }

  const finalMe = await apiRequest('/api/me', {}, wallet, auth);
  const finalCompetingCount = competingSlugs(finalMe).size;
  console.log('\nFinal report');
  console.log(`Address: ${wallet.address}`);
  console.log(`Entered: ${enteredCount}`);
  console.log(`Submitted: ${submittedCount}`);
  console.log(`Skipped: ${skipped.length}`);
  for (const item of skipped) console.log(`  - ${item.slug}: ${item.reason}`);
  console.log(`Current competing count: ${finalCompetingCount}`);
}

main().catch((error) => {
  console.error(`Agent failed: ${error.message}`);
  process.exitCode = 1;
});
