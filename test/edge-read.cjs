// 验证能否读取 Edge 历史数据库（node:sqlite + 复制后只读查询）
const fs = require("fs");
const os = require("os");
const path = require("path");

let DatabaseSync = null;
try {
  const m = require("node:sqlite");
  DatabaseSync = m.DatabaseSync;
  console.log("node:sqlite keys: " + Object.keys(m).join(",") + " | DatabaseSync type: " + typeof DatabaseSync);
} catch (e) {
  console.log("node:sqlite FAILED: " + e.message);
  process.exit(1);
}

const userData = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "User Data");
console.log("User Data dir: " + userData + " exists=" + fs.existsSync(userData));

if (!fs.existsSync(userData)) process.exit(0);

const profileDirs = fs.readdirSync(userData).filter((d) => {
  const full = path.join(userData, d);
  return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, "History"));
});
console.log("profiles with History: " + JSON.stringify(profileDirs));

for (const prof of profileDirs) {
  const src = path.join(userData, prof, "History");
  const dst = path.join(os.tmpdir(), "edge-hist-test-" + prof + "-" + Date.now());
  try {
    fs.copyFileSync(src, dst);
    const db = new DatabaseSync(dst, { readOnly: true });
    const cnt = db.prepare("SELECT COUNT(*) AS c FROM urls").get();
    const sample = db.prepare(
      "SELECT url, title, visit_count, (last_visit_time / 1000 - 11644473600000) AS last_ts FROM urls ORDER BY last_visit_time DESC LIMIT 3"
    ).all();
    console.log("[" + prof + "] urls rows: " + cnt.c);
    for (const r of sample) {
      console.log("  - " + r.visit_count + "x  " + new Date(Number(r.last_ts)).toISOString() + "  " + String(r.title || "").slice(0, 40) + "  " + String(r.url || "").slice(0, 80));
    }
    db.close();
  } catch (e) {
    console.log("[" + prof + "] read FAILED: " + e.message);
    if (e && e.stack) console.log(String(e.stack).split("\n").slice(0, 6).join("\n"));
  } finally {
    try { fs.unlinkSync(dst); } catch (e) {}
  }
}
