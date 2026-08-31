"use strict";

const fs = require("node:fs");
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  allowExitOnIdle: false
});

pool.on("error", (error) => console.error("Unexpected PostgreSQL pool error:", error));

async function initialize() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS links (
      slug VARCHAR(32) PRIMARY KEY,
      url VARCHAR(2048) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      clicks BIGINT NOT NULL DEFAULT 0 CHECK (clicks >= 0)
    );
    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS creation_rate_limits (
      client_key TEXT PRIMARY KEY,
      window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      attempts INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS link_click_shards (
      slug VARCHAR(32) NOT NULL REFERENCES links(slug) ON DELETE CASCADE,
      shard SMALLINT NOT NULL CHECK (shard >= 0 AND shard < 64),
      clicks BIGINT NOT NULL DEFAULT 0 CHECK (clicks >= 0),
      PRIMARY KEY (slug, shard)
    );
    CREATE OR REPLACE VIEW link_stats AS
      SELECT l.slug, l.url, l.created_at,
             l.clicks + COALESCE(SUM(s.clicks), 0)::BIGINT AS clicks
      FROM links l
      LEFT JOIN link_click_shards s ON s.slug = l.slug
      GROUP BY l.slug;
  `);
}

async function createLink(slug, url) {
  const result = await pool.query(
    `INSERT INTO links (slug, url)
     VALUES ($1, $2)
     ON CONFLICT (slug) DO NOTHING
     RETURNING slug, url, created_at AS "createdAt", clicks`,
    [slug, url]
  );
  return result.rows[0] || null;
}

async function resolveLink(slug) {
  const result = await pool.query(
    `WITH link AS (
       SELECT url FROM links WHERE slug = $1
     ), counted AS (
       INSERT INTO link_click_shards (slug, shard, clicks)
       SELECT $1, FLOOR(RANDOM() * 64)::SMALLINT, 1 FROM link
       ON CONFLICT (slug, shard) DO UPDATE
         SET clicks = link_click_shards.clicks + 1
       RETURNING 1
     )
     SELECT link.url FROM link JOIN counted ON TRUE`,
    [slug]
  );
  return result.rows[0] || null;
}

async function allowCreation(clientKey) {
  const result = await pool.query(
    `INSERT INTO creation_rate_limits (client_key, window_start, attempts)
     VALUES (encode(sha256($1::bytea), 'hex'), NOW(), 1)
     ON CONFLICT (client_key) DO UPDATE SET
       attempts = CASE
         WHEN creation_rate_limits.window_start < NOW() - INTERVAL '1 minute' THEN 1
         ELSE creation_rate_limits.attempts + 1
       END,
       window_start = CASE
         WHEN creation_rate_limits.window_start < NOW() - INTERVAL '1 minute' THEN NOW()
         ELSE creation_rate_limits.window_start
       END
     RETURNING attempts <= 20 AS allowed`,
    [clientKey]
  );
  return result.rows[0].allowed;
}

async function importLegacyFile(filePath) {
  let legacy;
  try {
    legacy = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('blink-legacy-json-import'))");
    const marker = await client.query("SELECT 1 FROM app_metadata WHERE key = 'legacy_json_imported'");
    if (marker.rowCount) {
      await client.query("COMMIT");
      return;
    }

    let imported = 0;
    for (const [slug, link] of Object.entries(legacy || {})) {
      if (!link || typeof link.url !== "string") continue;
      const result = await client.query(
        `INSERT INTO links (slug, url, created_at, clicks)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (slug) DO NOTHING`,
        [slug, link.url, link.createdAt || new Date().toISOString(), Math.max(0, Number(link.clicks) || 0)]
      );
      imported += result.rowCount;
    }

    await client.query(
      `INSERT INTO app_metadata (key, value) VALUES ('legacy_json_imported', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [String(imported)]
    );
    await client.query("COMMIT");
    console.log(`Legacy migration complete: ${imported} link(s) imported`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function isReady() {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

function close() { return pool.end(); }

module.exports = { initialize, createLink, resolveLink, allowCreation, importLegacyFile, isReady, close };
