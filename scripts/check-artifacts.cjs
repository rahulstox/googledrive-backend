const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..'); // Assuming scripts/ is one level deep
const ARTIFACT_PATTERNS = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.test',
  '.vscode',
  '.idea',
  '*.log',
  'coverage',
  '.DS_Store'
];

// Helper to check if file matches pattern (simple glob-like check)
function matches(filename, pattern) {
  if (pattern.startsWith('*')) return filename.endsWith(pattern.slice(1));
  return filename === pattern;
}

function walk(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  files.forEach(file => {
    const filepath = path.join(dir, file);
    const stat = fs.statSync(filepath);
    if (stat.isDirectory()) {
      if (file !== 'node_modules' && file !== '.git') {
        walk(filepath, fileList);
      }
    } else {
      fileList.push(filepath);
    }
  });
  return fileList;
}

console.log("Starting Artifact Cleanup Check...");

const allFiles = walk(ROOT_DIR);
let violations = [];

allFiles.forEach(file => {
  const basename = path.basename(file);
  ARTIFACT_PATTERNS.forEach(pattern => {
    if (matches(basename, pattern)) {
       // In a real build script we might delete, but here we audit
       violations.push(file);
    }
  });
});

if (violations.length > 0) {
  console.error("❌ Found unnecessary files in build context:");
  violations.forEach(v => console.error(`   - ${path.relative(ROOT_DIR, v)}`));
  // In a strict mode, we might exit 1, but for audit we just report
} else {
  console.log("✅ No unnecessary artifacts found.");
}
