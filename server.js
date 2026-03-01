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

// Environment
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'redx';
const BOTS_DIR = path.join(__dirname, 'bots');
const MAIN_REPO = 'https://github.com/AbdulRehman19721986/redxbot302.git';

if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });

// PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      github_username TEXT PRIMARY KEY,
      is_approved BOOLEAN DEFAULT true,
      max_bots INTEGER DEFAULT 1,
      expiry_date TIMESTAMP,
      subscription_plan TEXT,
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
      name TEXT,
      price TEXT,
      duration TEXT,
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

  await pool.query(
    `INSERT INTO servers (name, url, api_key, bot_count) 
     VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
    ['Railway Main', 'http://localhost', 'internal', 0]
  );

  const { rows } = await pool.query('SELECT COUNT(*) FROM plans');
  if (parseInt(rows[0].count) === 0) {
    await pool.query(
      `INSERT INTO plans (name, price, duration, max_bots, features) VALUES 
       ('Free', 'Free', 'Lifetime', 1, ARRAY['1 Bot', 'Basic Support']),
       ('Pro', '$5/month', '30 days', 3, ARRAY['3 Bots', 'Priority Support', 'Advanced Features']),
       ('Premium', '$10/month', '30 days', 10, ARRAY['10 Bots', 'VIP Support', 'All Features'])`
    );
  }
}
initDb().catch(console.error);

// GitHub fork check
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

// Clone repo
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

// Fix package.json: remove discard-api if present
function fixPackageJson(botPath) {
  const pkgPath = path.join(botPath, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { success: false, error: 'package.json not found' };
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    let modified = false;

    // Check dependencies
    if (pkg.dependencies && pkg.dependencies['discard-api']) {
      delete pkg.dependencies['discard-api'];
      modified = true;
      console.log(`Removed discard-api from dependencies of ${botPath}`);
    }
    // Check devDependencies
    if (pkg.devDependencies && pkg.devDependencies['discard-api']) {
      delete pkg.devDependencies['discard-api'];
      modified = true;
      console.log(`Removed discard-api from devDependencies of ${botPath}`);
    }

    if (modified) {
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      return { success: true, fixed: true };
    }
    return { success: true, fixed: false };
  } catch (err) {
    console.error('Error fixing package.json:', err.message);
    return { success: false, error: 'Invalid package.json: ' + err.message };
  }
}

// Install dependencies with auto-fix
async function installDependencies(botPath) {
  // First, fix package.json
  const fixResult = fixPackageJson(botPath);
  if (!fixResult.success) {
    return { success: false, error: fixResult.error };
  }

  try {
    // Use --no-audit --no-fund to reduce noise, and --force to bypass some errors
    await execPromise('npm install --no-audit --no-fund --force', { cwd: botPath });
    return { success: true, fixed: fixResult.fixed };
  } catch (err) {
    console.error('npm install error:', err.message);
    // If still failing, return detailed error
    return { 
      success: false, 
      error: 'npm install failed: ' + err.message,
      details: err.message
    };
  }
}

// Start bot with PM2 using npx
async function startBotWithPM2(appName, botPath) {
  return new Promise((resolve, reject) => {
    exec(`npx pm2 start index.js --name "${appName}"`, { cwd: botPath }, (err, stdout, stderr) => {
      if (err) {
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

// -------------------- API Routes --------------------

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/plans', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM plans WHERE is_active = true');
  res.json({ plans: rows });
});

app.post('/check-fork', async (req, res) => {
  const { githubUsername } = req.body;
  if (!githubUsername) return res.status(400).json({ error: 'Username required' });

  const forkInfo = await checkFork(githubUsername);
  const user = await pool.query('SELECT * FROM users WHERE github_username = $1', [githubUsername.toLowerCase()]);
  let userData = user.rows[0];
  if (!userData) {
    await pool.query('INSERT INTO users (github_username) VALUES ($1)', [githubUsername.toLowerCase()]);
    userData = { github_username: githubUsername.toLowerCase(), is_approved: true, max_bots: 1 };
  }

  const bots = await pool.query('SELECT app_name, created_at FROM bots WHERE github_username = $1', [githubUsername.toLowerCase()]);

  res.json({
    hasFork: forkInfo.hasFork,
    forkUrl: forkInfo.forkUrl,
    isApproved: userData.is_approved,
    maxBots: userData.max_bots,
    expiryDate: userData.expiry_date,
    subscriptionPlan: userData.subscription_plan,
    deployedBots: bots.rows,
    currentBots: bots.rows.length
  });
});

app.post('/deploy', async (req, res) => {
  const { githubUsername, sessionId, appName: customAppName, ...config } = req.body;
  if (!githubUsername || !sessionId) return res.status(400).json({ error: 'Missing fields' });

  const user = await pool.query('SELECT * FROM users WHERE github_username = $1', [githubUsername.toLowerCase()]);
  if (user.rows.length === 0) return res.status(403).json({ error: 'User not found' });
  const userData = user.rows[0];
  if (!userData.is_approved) return res.status(403).json({ error: 'User not approved' });

  const botCount = await pool.query('SELECT COUNT(*) FROM bots WHERE github_username = $1', [githubUsername.toLowerCase()]);
  if (parseInt(botCount.rows[0].count) >= userData.max_bots) {
    return res.status(403).json({ error: 'Bot limit reached' });
  }

  const appName = customAppName || `${githubUsername}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const botPath = path.join(BOTS_DIR, appName);

  // Clone
  const cloneResult = await cloneRepo(githubUsername, appName);
  if (!cloneResult.success) {
    return res.status(500).json({ error: 'Clone failed: ' + cloneResult.error });
  }

  // Write .env
  const envContent = Object.entries({
    SESSION_ID: sessionId,
    GITHUB_USERNAME: githubUsername,
    ...config
  }).map(([k, v]) => `${k}=${v}`).join('\n');
  fs.writeFileSync(path.join(botPath, '.env'), envContent);

  // Install dependencies (with auto-fix)
  const installResult = await installDependencies(botPath);
  if (!installResult.success) {
    // Clean up the cloned folder to avoid clutter
    fs.rm(botPath, { recursive: true, force: true }, () => {});
    return res.status(500).json({ error: installResult.error });
  }

  // Start with PM2
  try {
    await startBotWithPM2(appName, botPath);
  } catch (err) {
    fs.rm(botPath, { recursive: true, force: true }, () => {});
    return res.status(500).json({ error: 'PM2 start failed: ' + err.message });
  }

  // Save to DB
  await pool.query('INSERT INTO bots (app_name, github_username) VALUES ($1, $2)', [appName, githubUsername.toLowerCase()]);
  await pool.query('UPDATE servers SET bot_count = bot_count + 1 WHERE id = 1');

  // If we fixed package.json, include a warning in the response
  const message = installResult.fixed 
    ? 'Bot deployed successfully (note: removed "discard-api" from package.json)'
    : 'Bot deployed successfully';
  res.json({ success: true, appName, message });
});

app.post('/restart-app', async (req, res) => {
  const { appName } = req.body;
  try {
    await execPromise(`npx pm2 restart "${appName}"`);
    res.json({ success: true, message: 'Restarted' });
  } catch (err) {
    res.status(500).json({ error: 'Restart failed: ' + err.message });
  }
});

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

// Admin routes
app.post('/admin/users', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query('SELECT * FROM users');
  res.json({ users: rows });
});

app.post('/admin/update-user', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { githubUsername, isApproved, maxBots, expiryDate, subscriptionPlan } = req.body;
  await pool.query(
    `INSERT INTO users (github_username, is_approved, max_bots, expiry_date, subscription_plan)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (github_username) DO UPDATE SET
       is_approved = EXCLUDED.is_approved,
       max_bots = EXCLUDED.max_bots,
       expiry_date = EXCLUDED.expiry_date,
       subscription_plan = EXCLUDED.subscription_plan`,
    [githubUsername.toLowerCase(), isApproved, maxBots, expiryDate, subscriptionPlan]
  );
  res.json({ success: true });
});

app.post('/admin/delete-user', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  await pool.query('DELETE FROM users WHERE github_username = $1', [req.body.githubUsername.toLowerCase()]);
  res.json({ success: true });
});

app.post('/admin/plans', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query('SELECT * FROM plans');
  res.json({ plans: rows });
});

app.post('/admin/create-plan', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { name, price, duration, maxBots, features } = req.body;
  await pool.query(
    'INSERT INTO plans (name, price, duration, max_bots, features) VALUES ($1, $2, $3, $4, $5)',
    [name, price, duration, maxBots, features]
  );
  res.json({ success: true });
});

app.post('/admin/update-plan', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { id, name, price, duration, maxBots, features } = req.body;
  await pool.query(
    'UPDATE plans SET name=$1, price=$2, duration=$3, max_bots=$4, features=$5 WHERE id=$6',
    [name, price, duration, maxBots, features, id]
  );
  res.json({ success: true });
});

app.post('/admin/delete-plan', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  await pool.query('DELETE FROM plans WHERE id = $1', [req.body.id]);
  res.json({ success: true });
});

app.post('/admin/servers', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query('SELECT id, name, bot_count, status FROM servers');
  res.json({ servers: rows });
});

app.post('/get-all-apps', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query(`
    SELECT b.app_name, b.github_username, b.created_at, s.name as server_name
    FROM bots b
    JOIN servers s ON b.server_id = s.id
  `);
  res.json({ apps: rows });
});

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

app.post('/api/buy-plan', (req, res) => {
  const { planName, price, githubUsername } = req.body;
  const message = `I want to buy the ${planName} plan (${price}). My GitHub: ${githubUsername}`;
  const whatsappLink = `https://wa.me/923009842133?text=${encodeURIComponent(message)}`;
  res.json({ whatsappLink });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
