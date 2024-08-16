const express = require('express');
const pool = require('./db');
const { Server } = require("socket.io");

const app = express();
const port = 3001;

const cors = require('cors');

app.use(express.json());
app.use(cors());

app.get('/ticket/:ticket', async (req, res) => {
  const { ticket } = req.params;

  if (!ticket) {
    return res.status(400).send('número do ticket é obrigatório');
  }

  try {
    const result = await pool.query('SELECT * FROM TICKETS where ticket = ($1)', [ticket]);
    res.status(200).json(result.rows);
  } catch (err) {
    res.status(500).send('Erro GET /ticket');
    console.error(err);
  }
});


app.post('/ticket', async (req, res) => {
  const { ticket, sender, message } = req.body;

  if (!ticket) {
    return res.status(400).send('número do ticket é obrigatório');
  }

  try {
    const result = await pool.query(
      'INSERT INTO TICKETS (message, sender, ticket) VALUES ($1, $2, $3) RETURNING *',
      [message, sender, ticket]
    );

    res.status(200).json(result.rows[0]);
  } catch (err) {
    res.status(500).send('Erro POST /ticket');
    console.error(err);
  }
});


app.get('/alltickets', async (req, res) => {
  try {
    const result = await pool.query('SELECT ticket FROM TICKETS');

    res.status(200).json((result.rows).map((row) => row.ticket));
  } catch (err) {
    res.status(500).send('Erro GET /alltickets');
    console.error(err);
  }
});


const expressServer = app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});


// const io = new Server(expressServer, {
//   cors: {
//     origin: "*"
//   }
// });

// io.on("connection", (socket) => {
//   console.log(socket.id);
// });
