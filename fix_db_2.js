const fs = require('fs');
let file = fs.readFileSync('src/server/ws-handler.ts', 'utf8');

file = file.replace(/const pinnedRows = getAdapter\(\)\.prepare\([\s\S]*?all\(userId, projectId\)/, 
`const pinnedRows = await getAdapter().all(
            'SELECT file_path FROM pinned_files WHERE user_id = ? AND project_id = ? ORDER BY created_at ASC',
            [userId, projectId]
          )`);

fs.writeFileSync('src/server/ws-handler.ts', file, 'utf8');
console.log('Replaced successfully');
