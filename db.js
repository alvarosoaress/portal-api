import dotenv from 'dotenv';
import postgres from 'postgres';
import { runMigrations } from './migrate.js';

dotenv.config();

const sql = postgres(process.env.DATABASE_URL);

/**
 * Inicializa o banco de dados executando todas as migrations pendentes.
 * Deve ser chamada uma vez na inicializacao do servidor.
 */
export async function initDB() {
    await runMigrations(sql);
}

export default sql;
