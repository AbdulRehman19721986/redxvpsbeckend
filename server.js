const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const simpleGit = require('simple-git');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// -------------------- CONFIG --------------------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'redx';
const BOTS_DIR = path.join(__dirname, 'bots');
const MAIN_REPO = 'https://github.com/AbdulRehman19721986/redxbot302.git';

if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// -------------------- DATABASE INIT --------------------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      github_username TEXT PRIMARY KEY,
      is_approved BOOLEAN DEFAULT true,
      is_banned BOOLEAN DEFAULT false,
      max_bots INTEGER DEFAULT 2,
      deployment_count INTEGER DEFAULT 0,
      expiry_date TIMESTAMP,
      subscription_plan TEXT DEFAULT 'free',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bots (
      app_name TEXT PRIMARY KEY,
      github_username TEXT REFERENCES users(github_username) ON DELETE CASCADE,
      server_id INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW(),
      status TEXT DEFAULT 'running'
    );

    CREATE TABLE IF NOT EXISTS plans (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE,
      price TEXT,
      duration_days INTEGER,
      max_bots INTEGER,
      features TEXT[],
      is_active BOOLEAN DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS servers (
      id SERIAL PRIMARY KEY,
      name TEXT,
      url TEXT,
      api_key TEXT,
      bot_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'online'
    );
  `);

  // Insert default server
  await pool.query(
    `INSERT INTO servers (name, url, api_key, bot_count) 
     VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
    ['Railway Main', 'http://localhost', 'internal', 0]
  );

  // Insert default plans if none exist
  const { rows } = await pool.query('SELECT COUNT(*) FROM plans');
  if (parseInt(rows[0].count) === 0) {
    await pool.query(
      `INSERT INTO plans (name, price, duration_days, max_bots, features) VALUES 
       ('free', 'Free', 36500, 2, ARRAY['2 bots', 'Basic features', 'Community support']),
       ('pro', '$5/month', 30, 5, ARRAY['5 bots', 'Advanced features', 'Priority support']),
       ('premium', '$10/month', 30, 10, ARRAY['10 bots', 'All features', 'VIP support', 'Early access'])`
    );
  }
}
initDb().catch(console.error);

// -------------------- HELPER FUNCTIONS --------------------

// Check GitHub fork
async function checkFork(username) {
  try {
    const url = `https://api.github.com/repos/AbdulRehman19721986/redxbot302/forks?per_page=100`;
    const resp = await axios.get(url, { timeout: 10000 });
    const forks = resp.data;
    const userFork = forks.find(fork => fork.owner.login.toLowerCase() === username.toLowerCase());
    return { hasFork: !!userFork, forkUrl: userFork?.html_url };
  } catch (e) {
    console.error('GitHub API error:', e.message);
    return { hasFork: false, error: e.message };
  }
}

// Clone user's fork
async function cloneRepo(githubUsername, appName) {
  const repoUrl = `https://github.com/${githubUsername}/redxbot302.git`;
  const dest = path.join(BOTS_DIR, appName);
  try {
    await simpleGit().clone(repoUrl, dest);
    return { success: true };
  } catch (err) {
    console.error('Clone failed:', err.message);
    return { success: false, error: err.message };
  }
}

// Start bot with PM2 and verify it's running
async function startBotWithPM2(appName, botPath) {
  // Check if package.json exists and find main script
  const pkgPath = path.join(botPath, 'package.json');
  let mainScript = 'index.js';
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.main) mainScript = pkg.main;
    } catch (e) {
      console.warn('Could not parse package.json, using index.js');
    }
  }

  // Install dependencies if node_modules doesn't exist
  if (!fs.existsSync(path.join(botPath, 'node_modules'))) {
    console.log(`Installing dependencies for ${appName}...`);
    await execPromise('npm install --no-audit --no-fund', { cwd: botPath });
  }

  // Start the process
  console.log(`Starting ${appName} with PM2...`);
  await execPromise(`npx pm2 start ${mainScript} --name "${appName}"`, { cwd: botPath });

  // Wait a few seconds for the process to stabilize
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Check process status
  const { stdout } = await execPromise(`npx pm2 show "${appName}"`, { cwd: botPath }).catch(() => ({ stdout: '' }));
  if (!stdout.includes('online')) {
    // Process is not online, get logs
    const { stdout: logs } = await execPromise(`npx pm2 logs "${appName}" --lines 20 --nostream`, { cwd: botPath }).catch(() => ({ stdout: '' }));
    throw new Error(`Bot failed to start. Logs:\n${logs}`);
  }

  // Save PM2 list so it restarts with container
  await execPromise(`npx pm2 save`, { cwd: botPath });

  return { success: true, mainScript };
}

// -------------------- API ROUTES --------------------

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Get all active plans (public)
app.get('/api/plans', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM plans WHERE is_active = true');
  res.json({ plans: rows });
});

// Check fork and return user data (login endpoint)
app.post('/check-fork', async (req, res) => {
  const { githubUsername } = req.body;
  if (!githubUsername) return res.status(400).json({ error: 'Username required' });

  const forkInfo = await checkFork(githubUsername);
  const user = await pool.query('SELECT * FROM users WHERE github_username = $1', [githubUsername.toLowerCase()]);
  let userData = user.rows[0];

  // Create user if not exists
  if (!userData) {
    await pool.query(
      'INSERT INTO users (github_username, max_bots, subscription_plan) VALUES ($1, $2, $3)',
      [githubUsername.toLowerCase(), 2, 'free']
    );
    userData = { 
      github_username: githubUsername.toLowerCase(), 
      is_approved: true, 
      is_banned: false,
      max_bots: 2, 
      deployment_count: 0,
      subscription_plan: 'free' 
    };
  }

  // Get user's deployed bots
  const bots = await pool.query(
    'SELECT app_name, created_at, status FROM bots WHERE github_username = $1',
    [githubUsername.toLowerCase()]
  );

  res.json({
    hasFork: forkInfo.hasFork,
    forkUrl: forkInfo.forkUrl,
    isApproved: userData.is_approved,
    isBanned: userData.is_banned,
    maxBots: userData.max_bots,
    deploymentCount: userData.deployment_count,
    expiryDate: userData.expiry_date,
    subscriptionPlan: userData.subscription_plan,
    deployedBots: bots.rows,
    currentBots: bots.rows.length
  });
});

// Deploy bot
app.post('/deploy', async (req, res) => {
  const { githubUsername, sessionId, appName: customAppName, ...config } = req.body;
  if (!githubUsername || !sessionId) return res.status(400).json({ error: 'Missing fields' });

  // Check user
  const user = await pool.query('SELECT * FROM users WHERE github_username = $1', [githubUsername.toLowerCase()]);
  if (user.rows.length === 0) return res.status(403).json({ error: 'User not found' });
  const userData = user.rows[0];

  if (userData.is_banned) return res.status(403).json({ error: 'User is banned' });
  if (!userData.is_approved) return res.status(403).json({ error: 'User not approved' });

  // Check bot limit
  const botCount = await pool.query('SELECT COUNT(*) FROM bots WHERE github_username = $1', [githubUsername.toLowerCase()]);
  if (parseInt(botCount.rows[0].count) >= userData.max_bots) {
    return res.status(403).json({ error: `Bot limit reached (max ${userData.max_bots} bots)` });
  }

  const appName = customAppName || `${githubUsername}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const botPath = path.join(BOTS_DIR, appName);

  // Clone the user's fork
  console.log(`Cloning ${githubUsername}/redxbot302 as ${appName}...`);
  const cloneResult = await cloneRepo(githubUsername, appName);
  if (!cloneResult.success) {
    return res.status(500).json({ error: 'Clone failed: ' + cloneResult.error });
  }

  // Write .env file with all config
  const envContent = Object.entries({
    SESSION_ID: sessionId,
    OWNER_NUMBER: config.OWNER_NUMBER || '923009842133',
    BOT_NAME: config.BOT_NAME || 'REDXBOT302',
    PREFIX: config.PREFIX || '.',
    AUTO_STATUS_SEEN: config.AUTO_STATUS_SEEN || 'true',
    AUTO_STATUS_REACT: config.AUTO_STATUS_REACT || 'true',
    ANTI_DELETE: config.ANTI_DELETE || 'true',
    ANTI_LINK: config.ANTI_LINK || 'false',
    ALWAYS_ONLINE: config.ALWAYS_ONLINE || 'false',
    AUTO_REPLY: config.AUTO_REPLY || 'false',
    AUTO_STICKER: config.AUTO_STICKER || 'false',
    WELCOME: config.WELCOME || 'false',
    READ_MESSAGE: config.READ_MESSAGE || 'false',
    AUTO_TYPING: config.AUTO_TYPING || 'false',
    GITHUB_USERNAME: githubUsername
  }).map(([k, v]) => `${k}=${v}`).join('\n');
  fs.writeFileSync(path.join(botPath, '.env'), envContent);

  // Start the bot and verify
  try {
    console.log(`Starting bot ${appName}...`);
    const startResult = await startBotWithPM2(appName, botPath);

    // Update database
    await pool.query(
      'INSERT INTO bots (app_name, github_username, status) VALUES ($1, $2, $3)',
      [appName, githubUsername.toLowerCase(), 'running']
    );
    await pool.query(
      'UPDATE users SET deployment_count = deployment_count + 1 WHERE github_username = $1',
      [githubUsername.toLowerCase()]
    );
    await pool.query('UPDATE servers SET bot_count = bot_count + 1 WHERE id = 1');

    console.log(`Bot ${appName} deployed successfully`);
    res.json({ 
      success: true, 
      appName, 
      message: `Bot deployed and running (main script: ${startResult.mainScript})` 
    });
  } catch (err) {
    // Clean up on failure
    console.error(`Failed to start bot ${appName}:`, err.message);
    fs.rm(botPath, { recursive: true, force: true }, () => {});
    return res.status(500).json({ error: 'Bot failed to start: ' + err.message });
  }
});

// Get bot logs
app.post('/bot-logs', async (req, res) => {
  const { appName } = req.body;
  try {
    const { stdout } = await execPromise(`npx pm2 logs "${appName}" --lines 50 --nostream`, { cwd: BOTS_DIR });
    res.json({ success: true, logs: stdout });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch logs: ' + err.message });
  }
});

// Restart bot
app.post('/restart-app', async (req, res) => {
  const { appName } = req.body;
  try {
    await execPromise(`npx pm2 restart "${appName}"`);
    res.json({ success: true, message: 'Bot restarted' });
  } catch (err) {
    res.status(500).json({ error: 'Restart failed: ' + err.message });
  }
});

// Delete bot
app.post('/delete-app', async (req, res) => {
  const { appName, githubUsername } = req.body;
  const botPath = path.join(BOTS_DIR, appName);

  try {
    await execPromise(`npx pm2 delete "${appName}"`);
  } catch (err) {
    // Ignore if process doesn't exist
  }

  fs.rm(botPath, { recursive: true, force: true }, async (err) => {
    if (err) return res.status(500).json({ error: 'Folder deletion failed' });
    await pool.query('DELETE FROM bots WHERE app_name = $1', [appName]);
    await pool.query('UPDATE servers SET bot_count = bot_count - 1 WHERE id = 1');
    res.json({ success: true, message: 'Bot deleted' });
  });
});

// Get bot config
app.post('/get-config', (req, res) => {
  const { appName } = req.body;
  const envFile = path.join(BOTS_DIR, appName, '.env');
  if (!fs.existsSync(envFile)) return res.status(404).json({ error: 'Config not found' });
  const env = fs.readFileSync(envFile, 'utf8').split('\n').reduce((acc, line) => {
    const [key, ...valArr] = line.split('=');
    if (key) acc[key] = valArr.join('=');
    return acc;
  }, {});
  res.json({ success: true, config: env });
});

// Update bot config
app.post('/update-config', async (req, res) => {
  const { appName, config } = req.body;
  const botPath = path.join(BOTS_DIR, appName);
  const envContent = Object.entries(config).map(([k, v]) => `${k}=${v}`).join('\n');
  fs.writeFileSync(path.join(botPath, '.env'), envContent);
  try {
    await execPromise(`npx pm2 restart "${appName}"`);
    res.json({ success: true, message: 'Config updated and bot restarted' });
  } catch (err) {
    res.status(500).json({ error: 'Restart after config update failed' });
  }
});

// Buy plan – generates WhatsApp link
app.post('/api/buy-plan', (req, res) => {
  const { planName, price, githubUsername } = req.body;
  const message = `I want to buy the ${planName} plan (${price}). My GitHub: ${githubUsername}`;
  const whatsappLink = `https://wa.me/923009842133?text=${encodeURIComponent(message)}`;
  res.json({ whatsappLink });
});

// -------------------- ADMIN ROUTES --------------------

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) return res.json({ success: true });
  res.status(401).json({ error: 'Invalid password' });
});

// Get all users
app.post('/admin/users', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query(`
    SELECT u.*, COUNT(b.app_name) as active_bots 
    FROM users u 
    LEFT JOIN bots b ON u.github_username = b.github_username 
    GROUP BY u.github_username
  `);
  res.json({ users: rows });
});

// Update user (plan, ban, approve, max bots)
app.post('/admin/update-user', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { 
    githubUsername, 
    isApproved, 
    isBanned, 
    maxBots, 
    expiryDate, 
    subscriptionPlan 
  } = req.body;

  await pool.query(
    `UPDATE users SET 
      is_approved = COALESCE($2, is_approved),
      is_banned = COALESCE($3, is_banned),
      max_bots = COALESCE($4, max_bots),
      expiry_date = COALESCE($5, expiry_date),
      subscription_plan = COALESCE($6, subscription_plan)
     WHERE github_username = $1`,
    [githubUsername.toLowerCase(), isApproved, isBanned, maxBots, expiryDate, subscriptionPlan]
  );
  res.json({ success: true });
});

// Delete user and all their bots
app.post('/admin/delete-user', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { githubUsername } = req.body;

  // First delete all bots of this user
  const bots = await pool.query('SELECT app_name FROM bots WHERE github_username = $1', [githubUsername.toLowerCase()]);
  for (const bot of bots.rows) {
    try {
      await execPromise(`npx pm2 delete "${bot.app_name}"`);
      const botPath = path.join(BOTS_DIR, bot.app_name);
      fs.rmSync(botPath, { recursive: true, force: true });
    } catch (e) {
      console.warn(`Failed to delete bot ${bot.app_name}:`, e.message);
    }
  }

  await pool.query('DELETE FROM users WHERE github_username = $1', [githubUsername.toLowerCase()]);
  res.json({ success: true });
});

// Get all plans (admin)
app.post('/admin/plans', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query('SELECT * FROM plans');
  res.json({ plans: rows });
});

// Create plan
app.post('/admin/create-plan', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { name, price, duration_days, max_bots, features } = req.body;
  await pool.query(
    'INSERT INTO plans (name, price, duration_days, max_bots, features) VALUES ($1, $2, $3, $4, $5)',
    [name, price, duration_days, max_bots, features]
  );
  res.json({ success: true });
});

// Update plan
app.post('/admin/update-plan', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { id, name, price, duration_days, max_bots, features, is_active } = req.body;
  await pool.query(
    'UPDATE plans SET name=$1, price=$2, duration_days=$3, max_bots=$4, features=$5, is_active=$6 WHERE id=$7',
    [name, price, duration_days, max_bots, features, is_active, id]
  );
  res.json({ success: true });
});

// Delete plan
app.post('/admin/delete-plan', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  await pool.query('DELETE FROM plans WHERE id = $1', [req.body.id]);
  res.json({ success: true });
});

// Get servers
app.post('/admin/servers', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query('SELECT id, name, bot_count, status FROM servers');
  res.json({ servers: rows });
});

// Get all bots (admin)
app.post('/get-all-apps', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query(`
    SELECT b.app_name, b.github_username, b.created_at, b.status, s.name as server_name
    FROM bots b
    JOIN servers s ON b.server_id = s.id
    ORDER BY b.created_at DESC
  `);
  res.json({ apps: rows });
});

// Delete multiple bots (admin)
app.post('/delete-multiple-apps', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { apps } = req.body;
  const results = { success: [], failed: [] };

  for (const { name } of apps) {
    try {
      await execPromise(`npx pm2 delete "${name}"`);
      const botPath = path.join(BOTS_DIR, name);
      fs.rmSync(botPath, { recursive: true, force: true });
      await pool.query('DELETE FROM bots WHERE app_name = $1', [name]);
      results.success.push(name);
    } catch {
      results.failed.push(name);
    }
  }
  res.json({ success: true, results });
});

// -------------------- START SERVER --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
