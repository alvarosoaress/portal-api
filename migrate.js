import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Executa todas as migrations pendentes em ordem alfanumerica.
 *
 * 1. Garante que a tabela _migrations_sla existe
 * 2. Le todos os .sql de migrations/
 * 3. Filtra os que ainda nao foram executados
 * 4. Executa cada um dentro de uma transaction e registra em _migrations_sla
 *
 * @param {import('postgres').Sql} sql - Instancia do postgres
 */
export async function runMigrations(sql) {
    // Garantir que a tabela de controle existe
    await sql`
        CREATE TABLE IF NOT EXISTS _migrations_sla (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) UNIQUE NOT NULL,
            executed_at TIMESTAMPTZ DEFAULT NOW()
        )
    `;

    // Ler migrations ja executadas
    const executed = await sql`SELECT name FROM _migrations_sla ORDER BY name`;
    const executedSet = new Set(executed.map(row => row.name));

    // Ler arquivos .sql do diretorio de migrations
    const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith('.sql'))
        .sort();

    const pending = files.filter(f => !executedSet.has(f));

    if (pending.length === 0) {
        console.log('[migrations] Nenhuma migration pendente.');
        return;
    }

    console.log(`[migrations] ${pending.length} migration(s) pendente(s): ${pending.join(', ')}`);

    for (const file of pending) {
        const filePath = path.join(MIGRATIONS_DIR, file);
        const sqlContent = fs.readFileSync(filePath, 'utf-8');

        console.log(`[migrations] Executando ${file}...`);

        await sql.begin(async (tx) => {
            await tx.unsafe(sqlContent);
            await tx`INSERT INTO _migrations_sla (name) VALUES (${file})`;
        });

        console.log(`[migrations] ${file} executada com sucesso.`);
    }

    console.log('[migrations] Todas as migrations foram executadas.');
}
