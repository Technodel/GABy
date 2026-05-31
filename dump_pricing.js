const db = require('better-sqlite3')('data/suny.db');
const rows = db.prepare('SELECT mode, input_token_base_cost, output_token_base_cost, markup_formula FROM pricing_modes').all();
console.log(JSON.stringify(rows, null, 2));
