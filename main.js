require('dotenv').config();
const Web3 = require('web3');

// ========== ENV ==========
const RPC = process.env.OPTIMISM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const TOKEN_ADDRESS_RAW = process.env.TOKEN_ADDRESS;      // kontrak token yg mau dijual (contoh: ERC-20)
const ROUTER_ADDRESS_RAW = process.env.ROUTER_ADDRESS;    // isi router DEX di Optimism (contoh: Velodrome/UniV3), JANGAN kosong
const AMOUNT_IN_ETH = process.env.AMOUNT_IN || '0.1';     // jumlah token (dalam "ether" unit token) yg mau diswap
const RECIPIENT = process.env.RECIPIENT || '';            // opsional, default ke wallet sendiri

if (!RPC || !PRIVATE_KEY || !TOKEN_ADDRESS_RAW || !ROUTER_ADDRESS_RAW) {
  throw new Error('ENV kurang. Butuh OPTIMISM_RPC_URL, PRIVATE_KEY, TOKEN_ADDRESS, ROUTER_ADDRESS');
}

// ========== WEB3 ==========
const web3 = new Web3(new Web3.providers.HttpProvider(RPC));
const account = web3.eth.accounts.privateKeyToAccount(PRIVATE_KEY);
web3.eth.accounts.wallet.add(account);
web3.eth.defaultAccount = account.address;

// ========== CONST ==========
const TOKEN_ADDRESS = web3.utils.toChecksumAddress(TOKEN_ADDRESS_RAW);
const ROUTER_ADDRESS = web3.utils.toChecksumAddress(ROUTER_ADDRESS_RAW);
const WETH_OPTIMISM = web3.utils.toChecksumAddress('0x4200000000000000000000000000000000000006');
const TO = RECIPIENT ? web3.utils.toChecksumAddress(RECIPIENT) : account.address;

// ERC20 minimal ABI
const ERC20_ABI = [
  {"constant":true,"inputs":[{"name":"owner","type":"address"}],"name":"balanceOf","outputs":[{"name":"","type":"uint256"}],"type":"function"},
  {"constant":true,"inputs":[{"name":"owner","type":"address"},{"name":"spender","type":"address"}],"name":"allowance","outputs":[{"name":"","type":"uint256"}],"type":"function"},
  {"constant":false,"inputs":[{"name":"spender","type":"address"},{"name":"value","type":"uint256"}],"name":"approve","outputs":[{"name":"","type":"bool"}],"type":"function"},
  {"constant":true,"inputs":[],"name":"decimals","outputs":[{"name":"","type":"uint8"}],"type":"function"},
  {"constant":true,"inputs":[],"name":"symbol","outputs":[{"name":"","type":"string"}],"type":"function"}
];

// Router V2-style: swapExactTokensForETH
// (Kalau router kamu beda ABI-nya, sesuaikan function & argumennya)
const ROUTER_ABI = [
  {"constant":false,"inputs":[
    {"name":"amountIn","type":"uint256"},
    {"name":"amountOutMin","type":"uint256"},
    {"name":"path","type":"address[]"},
    {"name":"to","type":"address"},
    {"name":"deadline","type":"uint256"}
  ],"name":"swapExactTokensForETH","outputs":[{"name":"","type":"uint256[]"}],"stateMutability":"nonpayable","type":"function"}
];

// helper gas
async function gasParams() {
  const gasPrice = await web3.eth.getGasPrice(); // Optimism masih oke pakai gasPrice
  return { gasPrice }; // bisa tambahkan maxFeePerGas jika perlu
}

async function ensureAllowance(token, owner, spender, amount) {
  const current = await token.methods.allowance(owner, spender).call();
  if (web3.utils.toBN(current).gte(web3.utils.toBN(amount))) {
    console.log('[i] Allowance cukup, skip approve');
    return;
  }

  console.log('[i] Approving…');
  const approveTx = token.methods.approve(spender, amount);
  let gas;
  try {
    gas = await approveTx.estimateGas({ from: owner });
  } catch (e) {
    console.log('[warn] estimateGas approve gagal, fallback 60000:', e.message || e);
    gas = 60000; // fallback aman buat approve
  }
  const { gasPrice } = await gasParams();
  const receipt = await approveTx.send({ from: owner, gas, gasPrice });
  console.log('[✓] Approve tx:', receipt.transactionHash);
}

async function main() {
  // info dasar
  const chainId = await web3.eth.getChainId();
  if (chainId !== 10) {
    console.log(`[warn] Kamu tidak di Optimism mainnet (chainId=${chainId}). Pastikan RPC benar.`);
  }

  const token = new web3.eth.Contract(ERC20_ABI, TOKEN_ADDRESS);
  const decimals = await token.methods.decimals().call();
  const symbol = await token.methods.symbol().call().catch(()=>'');

  // convert amountIn sesuai decimals token
  const amountInUnits = web3.utils.toBN(web3.utils.toWei(AMOUNT_IN_ETH, 'ether')); // asumsikan token pakai 18 decimals
  // kalau decimals != 18, konversi manual
  if (parseInt(decimals) !== 18) {
    // scale: amount * 10^(decimals) / 10^18
    const scaleUp = web3.utils.toBN('10').pow(web3.utils.toBN(decimals));
    const scaleDown = web3.utils.toBN('10').pow(web3.utils.toBN(18));
    const scaled = amountInUnits.mul(scaleUp).div(scaleDown);
    console.log(`[i] decimals ${decimals}, amountIn scaled: ${scaled.toString()}`);
  }

  const bal = await token.methods.balanceOf(account.address).call();
  if (web3.utils.toBN(bal).lt(amountInUnits)) {
    throw new Error(`Saldo ${symbol || 'TOKEN'} tidak cukup. Balance=${bal}, butuh=${amountInUnits.toString()}`);
  }

  // pastikan allowance
  await ensureAllowance(token, account.address, ROUTER_ADDRESS, amountInUnits);

  // swap
  const router = new web3.eth.Contract(ROUTER_ABI, ROUTER_ADDRESS);
  const path = [TOKEN_ADDRESS, WETH_OPTIMISM];
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const amountOutMin = '0'; // TODO: ubah sesuai slippage

  const swapTx = router.methods.swapExactTokensForETH(
    amountInUnits.toString(),
    amountOutMin,
    path,
    TO,
    deadline
  );

  let gas;
  try {
    gas = await swapTx.estimateGas({ from: account.address });
  } catch (e) {
    console.log('[warn] estimateGas swap gagal, pakai fallback 250000:', e.message || e);
    gas = 250000; // fallback masuk akal untuk swap
  }

  // JANGAN biarkan gas=0
  if (!gas || Number(gas) === 0) {
    gas = 250000;
    console.log('[warn] gas hasil 0, set 250000');
  }

  const { gasPrice } = await gasParams();
  console.log(`[i] Mengirim swap… gas=${gas}, gasPrice=${gasPrice}`);

  const receipt = await swapTx.send({
    from: account.address,
    gas,
    gasPrice
  });

  console.log('[✓] Swap tx:', receipt.transactionHash);
  console.log('[✓] Selesai');
}

main().catch((e) => {
  console.error('[ERR]', e);
  process.exit(1);
});
