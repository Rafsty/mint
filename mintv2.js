require('dotenv').config();
const axios = require('axios');
const { ethers } = require('ethers');
const { randomUUID } = require('crypto');
const http = require('http');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');

const {
  PRIVATE_KEY,
  SCTG_KEY,
  TURNSTILE_SITEKEY,
  RPC,
  API_BASE,
  CLIENT_ID,
  RECIPIENT,
  RELAYER,
  TOKEN,
  MINT_COUNT =500
} = process.env;

const PROXY_URL = process.env.PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
let httpProxyAgent;
let httpsProxyAgent;

if (PROXY_URL) {
  try {
    httpProxyAgent = new HttpProxyAgent(PROXY_URL);
    httpsProxyAgent = new HttpsProxyAgent(PROXY_URL);
    axios.defaults.proxy = false;
    axios.defaults.httpAgent = httpProxyAgent;
    axios.defaults.httpsAgent = httpsProxyAgent;
    http.globalAgent = httpProxyAgent;
    https.globalAgent = httpsProxyAgent;
    console.log(`[proxy] Enabled via ${PROXY_URL}`);
  } catch (err) {
    console.warn("[proxy] Failed to enable proxy:", err?.message || err);
  }
}

const DEFAULT_RPC_CANDIDATES = [
  'https://bsc-dataseed.binance.org',
  'https://bsc-dataseed1.ninicoin.io',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.bnbchain.org',
  'https://rpc.ankr.com/bsc',
  'https://bscrpc.com'
];

let provider;
let wallet;
let WALLET;
let CHAIN_ID;
const SCTG_IN_URL = process.env.SCTG_IN_URL || "https://api.sctg.xyz/in.php";
const SCTG_RES_URL = process.env.SCTG_RES_URL || "https://api.sctg.xyz/res.php";

const delay = (ms) => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------
   WATCHER — trigger claim realtime
-------------------------------------------*/
const WATCH_ADDR = [
  "0x39dcdd14a0c40e19cd8c892fd00e9e7963cd49d3".toLowerCase(),
  "0xafcD15f17D042eE3dB94CdF6530A97bf32A74E02".toLowerCase()
];
const WATCH_WINDOW = Number(process.env.WATCH_WINDOW || 15);
let lastBlock = 0;
let watcherBusy = false;
let jwtToken;
let approvedOnce = false;

function buildRpcList() {
  const list = [];
  if (RPC && RPC.trim()) {
    list.push(RPC.trim());
  }
  const extra = process.env.RPC_FALLBACKS || '';
  if (extra.trim()) {
    extra
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => list.push(item));
  }
  DEFAULT_RPC_CANDIDATES.forEach((item) => list.push(item));
  return [...new Set(list)];
}

async function initProvider() {
  const endpoints = buildRpcList();
  if (!endpoints.length) {
    throw new Error("No RPC endpoints configured.");
  }

  const failures = [];
  for (const url of endpoints) {
    try {
      console.log(`[RPC] Trying ${url} ...`);
      const candidate = new ethers.providers.JsonRpcProvider(url);
      const chainIdHex = await candidate.send("eth_chainId", []);
      const chainId = Number.parseInt(chainIdHex, 16);
      console.log(`[RPC] Connected to ${url} (chainId ${chainId || "unknown"}).`);
      return { provider: candidate, chainId };
    } catch (err) {
      const reason = err?.reason || err?.code || err?.message || String(err);
      console.warn(`[RPC] ${url} failed: ${reason}`);
      failures.push(`${url} (${reason})`);
    }
  }

  throw new Error(`Unable to reach any RPC endpoints. Tried: ${failures.join("; ")}`);
}

/* -------------------------------------------------------------
   CAPTCHA SOLVER
-------------------------------------------------------------*/
async function solveTurnstile() {
  if (!SCTG_KEY) {
    throw new Error("SCTG_KEY env var is required to solve CAPTCHA with SCTG");
  }

  const query = new URLSearchParams({
    key: SCTG_KEY,
    method: "turnstile",
    sitekey: TURNSTILE_SITEKEY,
    pageurl: "https://www.b402.ai/experience-b402",
    json: 1
  }).toString();

  const job = await axios.get(`${SCTG_IN_URL}?${query}`);
  if (job.data.status !== 1) {
    throw new Error(`Failed to queue CAPTCHA: ${job.data.request || "unknown error"}`);
  }
  const id = job.data.request;

  while (true) {
    await delay(5000);
    const params = new URLSearchParams({
      key: SCTG_KEY,
      action: "get",
      id,
      json: 1
    }).toString();
    const r = await axios.get(`${SCTG_RES_URL}?${params}`);

    if (r.data.status === 1) return r.data.request;
    process.stdout.write(".");
  }
}

/* -------------------------------------------------------------
   AUTH
-------------------------------------------------------------*/
async function getChallenge(ts) {
  const lid = randomUUID();
  const res = await axios.post(`${API_BASE}/auth/web3/challenge`, {
    walletType: "evm",
    walletAddress: WALLET,
    clientId: CLIENT_ID,
    lid,
    turnstileToken: ts
  });
  return { lid, challenge: res.data };
}

async function verifyChallenge(lid, sig, ts) {
  const res = await axios.post(`${API_BASE}/auth/web3/verify`, {
    walletType: "evm",
    walletAddress: WALLET,
    clientId: CLIENT_ID,
    lid,
    signature: sig,
    turnstileToken: ts
  });
  return res.data;
}

/* -------------------------------------------------------------
   APPROVE USDT UNLIMITED
-------------------------------------------------------------*/
async function approveUnlimited() {
  const abi = ["function approve(address spender, uint256 value)"];
  const token = new ethers.Contract(TOKEN, abi, wallet);

  const Max = ethers.constants.MaxUint256;
  console.log("🟦 Approving unlimited USDT for relayer...");

  const tx = await token.approve(RELAYER, Max);
  console.log("🔄 Approve TX:", tx.hash);
  await tx.wait();

  console.log("🟩 Unlimited USDT approved!");
}

/* -------------------------------------------------------------
   PERMIT BUILDER (VALID)
-------------------------------------------------------------*/
async function buildPermit(amount, relayer) {
  if (!CHAIN_ID && provider) {
    const net = await provider.getNetwork();
    CHAIN_ID = net.chainId;
  }
  const chainId = CHAIN_ID || 56;
  const now = Math.floor(Date.now() / 1000);

  const msg = {
    token: TOKEN,
    from: WALLET,
    to: RECIPIENT,
    value: amount,
    validAfter: now - 20,
    validBefore: now + 1800,
    nonce: ethers.utils.hexlify(ethers.utils.randomBytes(32))
  };

  const domain = {
    name: "B402",
    version: "1",
    chainId,
    verifyingContract: relayer
  };

  const types = {
    TransferWithAuthorization: [
      { name: "token", type: "address" },
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" }
    ]
  };

  const sig = await wallet._signTypedData(domain, types, msg);
  return { authorization: msg, signature: sig };
}

async function fetchPaymentRequirement(jwt) {
  console.log("dY\"? Fetching REAL payment requirement...");
  try {
    await axios.post(
      `${API_BASE}/faucet/drip`,
      { recipientAddress: RECIPIENT },
      { headers: { Authorization: `Bearer ${jwt}` } }
    );
  } catch (err) {
    if (err.response?.status === 402) {
      const req = err.response.data.paymentRequirements;
      console.log("dY'  Payment requirement FOUND:", req.amount);
      return req;
    }
    throw err;
  }
  throw new Error("Cannot obtain payment requirement: faucet drip did not return 402.");
}

async function blastPermits(pay, jwt) {
  console.log(`dY  Building ${MINT_COUNT} turbo permits...`);
  const permits = [];
  for (let i = 0; i < MINT_COUNT; i++) {
    permits.push(await buildPermit(pay.amount, pay.relayerContract));
    console.log(` o" Permit ${i + 1}`);
  }

  console.log("\ndYs? BLASTING PERMITS (ultra-parallel)...");

  await Promise.all(
    permits.map(async (p, i) => {
      try {
        const r = await axios.post(
          `${API_BASE}/faucet/drip`,
          {
            recipientAddress: RECIPIENT,
            paymentPayload: { token: TOKEN, payload: p },
            paymentRequirements: {
              network: pay.network,
              relayerContract: pay.relayerContract
            }
          },
          { headers: { Authorization: `Bearer ${jwt}` } }
        );

        console.log(`dYYc Mint #${i + 1} SUCCESS  +' ${r.data.nftTransaction}`);
      } catch (e) {
        console.log(`dYY  Mint #${i + 1} FAILED  +'`, e.response?.data || e.message);
      }
    })
  );
}

async function performLogin() {
  const ts = await solveTurnstile();
  const { lid, challenge } = await getChallenge(ts);
  const signed = await wallet.signMessage(challenge.message);
  const verify = await verifyChallenge(lid, signed, ts);
  const jwt = verify.jwt || verify.token;
  console.log("dYYc Logged in!");
  return jwt;
}

async function runClaimFlow(attempt = 0) {
  if (!jwtToken) {
    jwtToken = await performLogin();
  }

  if (!approvedOnce) {
    await approveUnlimited();
    approvedOnce = true;
  }

  try {
    const pay = await fetchPaymentRequirement(jwtToken);
    await blastPermits(pay, jwtToken);
  } catch (err) {
    if (err.response?.status === 401 && attempt < 1) {
      console.log("dY?? JWT expired, re-authenticating...");
      jwtToken = null;
      return runClaimFlow(attempt + 1);
    }
    throw err;
  }
}

async function watchDistribution() {
  console.log(` Watching distribution… (window ${WATCH_WINDOW}s)`);

  while (true) {
    try {
      const block = await provider.getBlockNumber();

      if (block > lastBlock) {
        const data = await provider.getBlockWithTransactions(block);
        lastBlock = block;

        if (!data) {
          continue;
        }

        const now = Math.floor(Date.now() / 1000);
        const isFreshBlock = Math.abs(now - (data.timestamp || now)) <= WATCH_WINDOW;

        for (let tx of data.transactions) {
          const from = tx.from?.toLowerCase();
          if (
            from &&
            isFreshBlock &&
            WATCH_ADDR.includes(from) &&
            !watcherBusy
          ) {
            console.log(" DISTRIBUTION TX DETECTED from:", tx.from);

            watcherBusy = true;
            try {
              await runClaimFlow();
            } catch (err) {
              console.log("⚠ Claim flow error:", err?.message || err);
            }
            watcherBusy = false;

            console.log(" Restarting watcher…");
            break;
          }
        }
      }
    } catch (err) {
      console.log("⚠ Watcher error:", err.message);
      await delay(4000);
    }

    await delay(2000);
  }
}

/* -------------------------------------------------------------
   MAIN
-------------------------------------------------------------*/
(async () => {
  try {
    const { provider: readyProvider, chainId } = await initProvider();
    provider = readyProvider;
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    WALLET = wallet.address;
    CHAIN_ID = chainId || CHAIN_ID || 56;
    console.log(`[RPC] Active endpoint ready (chainId ${CHAIN_ID}).`);

    console.log("Watcher armed - waiting for dev distribution...");
    jwtToken = await performLogin();
    await watchDistribution();

  } catch (error) {
    console.error("❌ Fatal error:", error?.message || error);
    process.exitCode = 1;
  }
})();
