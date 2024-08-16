const { Pool } = require('pg');
require('dotenv').config()

const pool = new Pool({
  user: process.env.BDUSER,
  host: process.env.BDHOST,
  database: process.env.BDDATABASE,
  password: process.env.BDPASSWORD,
  port: process.env.BDPORT,
});

module.exports = pool;