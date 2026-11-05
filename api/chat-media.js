const DB_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(commands) {
  const response = await fetch(DB_URL + "/pipeline", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + DB_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  if (!response.ok) throw new Error("Database error " + response.status);
  return (await response.json()).map((item) => item.result);
}

/* Mengirim foto chat yang disimpan di Redis (base64) sebagai gambar JPEG,
   hanya untuk dua orang yang saling mengikuti dan memang punya chat itu. */
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "POST")
    return res.status(405).json({ error: "Gunakan POST" });
  if (!DB_URL || !DB_TOKEN)
    return res.status(500).json({ error: "Database belum terhubung" });

  let body = req.body;
  try {
    if (typeof body === "string") body = JSON.parse(body);
  } catch (e) {
    body = null;
  }
  if (
    !body ||
    typeof body.uid !== "string" ||
    !/^[a-f0-9]{64}$/.test(body.uid) ||
    typeof body.id !== "string" ||
    !/^[a-z0-9]{24}$/.test(body.id) ||
    typeof body.pathname !== "string"
  )
    return res.status(400).json({ error: "Permintaan foto tidak valid" });

  try {
    const [ownId] = await redis([["GET", "social:owner:" + body.uid]]);
    if (
      typeof ownId !== "string" ||
      !/^[a-z0-9]{24}$/.test(ownId) ||
      ownId === body.id
    )
      return res.status(403).json({ error: "Akses foto tidak diizinkan" });

    const thread = [ownId, body.id].sort().join(":");
    const [targetOwner, follows, followedBy, uploadedNew, uploadedOld] =
      await redis([
        ["GET", "social:owner:" + body.id],
        ["SISMEMBER", "social:following:" + ownId, body.id],
        ["SISMEMBER", "social:followers:" + ownId, body.id],
        ["SISMEMBER", `chat:${thread}:media`, body.pathname],
        ["SISMEMBER", "chat:media:" + thread, body.pathname],
      ]);
    const uploaded = Number(uploadedNew) === 1 || Number(uploadedOld) === 1 ? 1 : 0;
    if (
      !targetOwner ||
      Number(follows) !== 1 ||
      Number(followedBy) !== 1 ||
      Number(uploaded) !== 1 ||
      !body.pathname.startsWith(`chat/${thread}/`) ||
      !/^chat\/[a-z0-9]{24}:[a-z0-9]{24}\/[0-9a-f-]{36}\.jpg$/.test(
        body.pathname,
      )
    )
      return res.status(403).json({ error: "Akses foto tidak diizinkan" });

    const [src] = await redis([["GET", "chat:img:" + body.pathname]]);
    if (
      typeof src !== "string" ||
      !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(src)
    )
      return res
        .status(404)
        .json({ error: "Foto sudah kedaluwarsa atau tidak ditemukan" });

    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.status(200).send(Buffer.from(src.slice(src.indexOf(",") + 1), "base64"));
  } catch (error) {
    return res.status(500).json({
      error: String(error.message || error),
    });
  }
};
