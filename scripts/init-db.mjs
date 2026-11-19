import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'tarea3_deslizamientos_quindio',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
});

try {
  const schema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await pool.query(schema);
  console.log(`Esquema listo en ${process.env.DB_NAME || 'tarea3_deslizamientos_quindio'}.`);
} catch (error) {
  console.error('No se pudo inicializar el esquema:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
