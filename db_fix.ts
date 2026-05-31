import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.resolve('./data/suny.db');
const db = new Database(DB_PATH);

const formulas = db.prepare('SELECT mode, markup_formula FROM pricing_modes').all();
console.log('--- pricing_modes formulas ---');
console.log(JSON.stringify(formulas, null, 2));

db.close();
