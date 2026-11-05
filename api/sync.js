// Backend sederhana iLovegym: menyimpan & mengambil datamu lewat database Upstash Redis.
const DB_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmds) {
  const r = await fetch(DB_URL + "/pipeline", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + DB_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error("Database error " + r.status);
  return (await r.json()).map((x) => x.result);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST")
    return res.status(405).json({ error: "Gunakan POST" });
  if (!DB_URL || !DB_TOKEN)
    return res.status(500).json({ error: "Database belum terhubung" });

  let b = req.body;
  try {
    if (typeof b === "string") b = JSON.parse(b);
  } catch (e) {
    b = null;
  }
  if (!b || typeof b.op !== "string")
    return res.status(400).json({ error: "Perintah tidak valid" });

  const uid = b.uid;
  const validUid = (value) =>
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const okId = (id) => typeof id === "string" && /^[\w-]{1,40}$/.test(id);
  const okPublicId = (id) =>
    typeof id === "string" && /^[a-z0-9]{24}$/.test(id);
  const profileKey = (id) => "social:profile:" + id;
  const usernameKey = (username) => "social:username:" + username;
  const followersKey = (id) => "social:followers:" + id;
  const followingKey = (id) => "social:following:" + id;

  try {
    if (b.op === "username_lookup") {
      const username =
        typeof b.username === "string" ? b.username.toLowerCase() : "";
      if (!/^[a-z0-9_]{3,20}$/.test(username))
        return res.status(400).json({ error: "Username tidak valid" });
      const [id] = await redis([["GET", usernameKey(username)]]);
      if (!okPublicId(id)) return res.json({ id: null });
      const [rawProfile] = await redis([["GET", profileKey(id)]]);
      const profile = rawProfile ? JSON.parse(rawProfile) : null;
      return res.json({
        id: profile && profile.username === username ? id : null,
      });
    }

    if (b.op === "public_get") {
      if (!okPublicId(b.id))
        return res.status(400).json({ error: "Tautan profil tidak valid" });
      const [profile, followers] = await redis([
        ["GET", profileKey(b.id)],
        ["SCARD", followersKey(b.id)],
      ]);
      return res.json({
        profile: profile ? JSON.parse(profile) : null,
        followers: Number(followers || 0),
      });
    }

    if (!validUid(uid))
      return res.status(400).json({ error: "Kode tidak valid" });

    if (b.op === "identity") {
      if (!okPublicId(b.id))
        return res.status(400).json({ error: "ID profil tidak valid" });
      const ownerKey = "social:owner:" + uid;
      const reverseKey = "social:owner:" + b.id;
      const [owned, claimed] = await redis([
        ["GET", ownerKey],
        ["GET", reverseKey],
      ]);
      if (owned) return res.json({ id: owned });
      if (claimed && claimed !== uid)
        return res
          .status(409)
          .json({ error: "ID profil sudah dipakai. Coba lagi." });
      await redis([
        ["SET", ownerKey, b.id],
        ["SET", reverseKey, uid],
      ]);
      return res.json({ id: b.id });
    }

    if (b.op === "publish") {
      if (!okPublicId(b.id) || typeof b.enabled !== "boolean")
        return res.status(400).json({ error: "Pengaturan profil tidak valid" });
      const [owned, owner] = await redis([
        ["GET", "social:owner:" + uid],
        ["GET", "social:owner:" + b.id],
      ]);
      if (owned !== b.id || owner !== uid)
        return res.status(403).json({ error: "Profil bukan milik akun ini" });
      if (!b.enabled) {
        const result = await redis([
          [
            "EVAL",
            `local raw = redis.call('GET', KEYS[1])
if raw then
  local ok, profile = pcall(cjson.decode, raw)
  if ok and type(profile) == 'table' and type(profile.username) == 'string' then
    local key = ARGV[1] .. profile.username
    if redis.call('GET', key) == ARGV[2] then redis.call('DEL', key) end
  end
end
redis.call('DEL', KEYS[1])
return 'OK'`,
            1,
            profileKey(b.id),
            "social:username:",
            b.id,
          ],
        ]);
        if (result[0] !== "OK")
          throw new Error("Gagal menonaktifkan profil publik");
        return res.json({ ok: true, published: false });
      }

      const source =
        b.profile && typeof b.profile === "object" ? b.profile : {};
      const safeText = (value, max) =>
        typeof value === "string" ? value.slice(0, max) : "";
      const [existingProfileRaw] = await redis([["GET", profileKey(b.id)]]);
      const existingProfile = existingProfileRaw
        ? JSON.parse(existingProfileRaw)
        : null;
      const requestedUsername = Object.prototype.hasOwnProperty.call(
        source,
        "username",
      )
        ? source.username
        : existingProfile && existingProfile.username;
      const username =
        typeof requestedUsername === "string"
          ? requestedUsername.toLowerCase()
          : "";
      if (username && !/^[a-z0-9_]{3,20}$/.test(username))
        return res
          .status(400)
          .json({
            error: "Username harus 3–20 huruf, angka, atau garis bawah",
          });
      const workouts = Array.isArray(source.workouts)
        ? source.workouts.slice(0, 1500).flatMap((workout) => {
            if (
              !workout ||
              typeof workout !== "object" ||
              !/^\d{4}-\d{2}-\d{2}$/.test(workout.date || "")
            )
              return [];
            return [
              {
                date: workout.date,
                focus: safeText(workout.focus, 100),
                exercises: Array.isArray(workout.exercises)
                  ? workout.exercises.slice(0, 30).map((exercise) => ({
                      name: safeText(exercise && exercise.name, 80),
                      sets: safeText(exercise && exercise.sets, 30),
                      reps: safeText(exercise && exercise.reps, 30),
                      weight: safeText(exercise && exercise.weight, 30),
                    }))
                  : [],
              },
            ];
          })
        : [];
      const weightLogs = Array.isArray(source.weightLogs)
        ? source.weightLogs.slice(0, 1500).flatMap((log) => {
            if (
              !log ||
              typeof log !== "object" ||
              !/^\d{4}-\d{2}-\d{2}$/.test(log.date || "")
            )
              return [];
            return [{ date: log.date, weight: safeText(log.weight, 30) }];
          })
        : [];
      const profile = {
        id: b.id,
        name: safeText(source.name, 80),
        username,
        motto: safeText(source.motto, 160),
        avatar:
          typeof source.avatar === "string" &&
          source.avatar.startsWith("data:image/jpeg;base64,") &&
          source.avatar.length <= 80000
            ? source.avatar
            : "",
        stats: {
          sessions: Number.isSafeInteger(source.stats && source.stats.sessions)
            ? Math.max(0, source.stats.sessions)
            : 0,
          streak: Number.isSafeInteger(source.stats && source.stats.streak)
            ? Math.max(0, source.stats.streak)
            : 0,
        },
        workouts,
        weightLogs,
        badges: Array.isArray(source.badges)
          ? source.badges.slice(0, 100).map((badge) => safeText(badge, 80))
          : [],
      };
      const serialized = JSON.stringify(profile);
      if (serialized.length > 350000)
        return res
          .status(413)
          .json({ error: "Hasil yang dibagikan terlalu besar" });
      const result = await redis([
        [
          "EVAL",
          `local raw = redis.call('GET', KEYS[1])
local previous = ''
if raw then
  local ok, profile = pcall(cjson.decode, raw)
  if ok and type(profile) == 'table' and type(profile.username) == 'string' then
    previous = profile.username
  end
end
local username = ARGV[1]
local id = ARGV[2]
local prefix = ARGV[3]
if username ~= '' then
  local owner = redis.call('GET', prefix .. username)
  if owner and owner ~= id then return 'TAKEN' end
end
if previous ~= '' and previous ~= username then
  local oldKey = prefix .. previous
  if redis.call('GET', oldKey) == id then redis.call('DEL', oldKey) end
end
if username ~= '' then redis.call('SET', prefix .. username, id) end
redis.call('SET', KEYS[1], ARGV[4])
return 'OK'`,
          1,
          profileKey(b.id),
          username,
          b.id,
          "social:username:",
          serialized,
        ],
      ]);
      if (result[0] === "TAKEN")
        return res
          .status(409)
          .json({ error: "Username sudah dipakai. Pilih username lain." });
      if (result[0] !== "OK") throw new Error("Gagal menyimpan profil publik");
      return res.json({ ok: true, published: true });
    }

    if (b.op === "follow" || b.op === "unfollow") {
      if (!okPublicId(b.id))
        return res.status(400).json({ error: "ID profil tidak valid" });
      const [ownId, target] = await redis([
        ["GET", "social:owner:" + uid],
        ["GET", profileKey(b.id)],
      ]);
      if (!ownId)
        return res
          .status(400)
          .json({
            error: "Hubungkan akun dan buka profil publikmu terlebih dahulu",
          });
      if (ownId === b.id)
        return res
          .status(400)
          .json({ error: "Kamu tidak bisa mengikuti akun sendiri" });
      if (b.op === "follow" && !target)
        return res
          .status(404)
          .json({ error: "Profil ini belum dibagikan atau tidak ditemukan" });
      const command = b.op === "follow" ? "SADD" : "SREM";
      await redis([
        [command, followingKey(ownId), b.id],
        [command, followersKey(b.id), ownId],
      ]);
      return res.json({ ok: true, following: b.op === "follow" });
    }

    if (b.op === "social_get") {
      const [ownId] = await redis([["GET", "social:owner:" + uid]]);
      if (!ownId) return res.json({ id: null, following: [], followers: [] });
      const [following, followers] = await redis([
        ["SMEMBERS", followingKey(ownId)],
        ["SMEMBERS", followersKey(ownId)],
      ]);
      const ids = [
        ...new Set([...(following || []), ...(followers || [])]),
      ].filter(okPublicId);
      const profiles = ids.length
        ? await redis(ids.map((id) => ["GET", profileKey(id)]))
        : [];
      const byId = Object.fromEntries(
        ids.map((id, i) => [id, profiles[i] ? JSON.parse(profiles[i]) : null]),
      );
      return res.json({
        id: ownId,
        following: (following || [])
          .slice(0, 200)
          .map((id) => ({ id, profile: byId[id] || null })),
        followers: (followers || [])
          .slice(0, 200)
          .map((id) => ({ id, profile: byId[id] || null })),
      });
    }

    const D = "d:" + uid,
      P = "p:" + uid;

    if (b.op === "get") {
      const [rec, photos] = await redis([
        ["GET", D],
        ["SMEMBERS", P],
      ]);
      return res.json({
        rec: rec ? JSON.parse(rec) : null,
        photos: photos || [],
      });
    }
    if (b.op === "put") {
      const s = JSON.stringify(b.rec || {});
      if (s.length > 900000)
        return res.status(413).json({ error: "Data terlalu besar" });
      await redis([["SET", D, s]]);
      return res.json({ ok: true });
    }
    if (b.op === "photo_put") {
      if (!okId(b.id) || typeof b.src !== "string" || b.src.length > 700000)
        return res
          .status(400)
          .json({ error: "Foto tidak valid atau terlalu besar" });
      await redis([
        ["SET", "i:" + uid + ":" + b.id, b.src],
        ["SADD", P, b.id],
      ]);
      return res.json({ ok: true });
    }
    if (b.op === "photo_get") {
      if (!okId(b.id)) return res.status(400).json({ error: "ID salah" });
      const [src] = await redis([["GET", "i:" + uid + ":" + b.id]]);
      return res.json({ src: src || "" });
    }
    if (b.op === "photo_del") {
      if (!okId(b.id)) return res.status(400).json({ error: "ID salah" });
      await redis([
        ["DEL", "i:" + uid + ":" + b.id],
        ["SREM", P, b.id],
      ]);
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: "Perintah tidak dikenal" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
