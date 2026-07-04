const fs = require('fs');
const path = require('path');

const CHECKPOINT_PATH = path.join(__dirname, '..', 'data', 'migration-checkpoint.json');

// Structure persisted to disk:
// { "<itemId>": { status: "pending"|"listed_on_b"|"removed_from_a"|"failed",
//                 newItemIdOnB, error, updatedAt } }
function loadCheckpoint() {
  try {
    if (!fs.existsSync(CHECKPOINT_PATH)) return {};
    const raw = fs.readFileSync(CHECKPOINT_PATH, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error('[checkpoint] Failed to load, starting fresh:', err.message);
    return {};
  }
}

function saveCheckpoint(data) {
  fs.mkdirSync(path.dirname(CHECKPOINT_PATH), { recursive: true });
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(data, null, 2));
}

function updateItem(itemId, patch) {
  const data = loadCheckpoint();
  data[itemId] = { ...(data[itemId] || {}), ...patch, updatedAt: new Date().toISOString() };
  saveCheckpoint(data);
  return data[itemId];
}

function getItemStatus(itemId) {
  const data = loadCheckpoint();
  return data[itemId] || null;
}

module.exports = { loadCheckpoint, saveCheckpoint, updateItem, getItemStatus, CHECKPOINT_PATH };