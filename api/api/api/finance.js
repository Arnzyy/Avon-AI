export default async function handler(req, res) {
  try {
    const body = req.method === "POST" ? JSON.parse(req.body || "{}") : {};
    const { cashPrice, deposit = 0, termMonths = 60, apr = 9.9, feeSetup = 0, feeOption = 0 } = body;

    // Principal after deposit + any setup fee
    const P = Math.max(0, (cashPrice || 0) - (deposit || 0) + (feeSetup || 0));
    const r = (apr / 100) / 12;                   // monthly rate
    const n = Math.max(1, termMonths);            // number of months

    // Standard amortization formula
    const monthly = r === 0
      ? P / n
      : (r * P * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);

    res.json({
      monthly: Number(monthly.toFixed(2)),
      lastPayment: Number((monthly + (feeOption || 0)).toFixed(2)),
      apr,
      termMonths: n,
      deposit,
      cashPrice,
      disclaimer: "Representative example. Subject to status. T&Cs apply."
    });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
}
