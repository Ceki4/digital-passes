require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { auth: requireAuth, requiresAuth } = require('express-openid-connect');
const { auth: checkJwt, requiredScopes } = require('express-oauth2-jwt-bearer');
const QRCode = require('qrcode');
const { v4: uuidv4, validate: isUuid } = require('uuid');

const app = express();
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

pool.query(`
  CREATE TABLE IF NOT EXISTS passes (
      id UUID PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      document VARCHAR(100) NOT NULL,
      issued_at TIMESTAMPTZ NOT NULL,
      status VARCHAR(20) NOT NULL
  );
`).catch(err => {
    console.error(err);
});

const config = {
    authRequired: false,
    auth0Logout: true,
    secret: process.env.AUTH0_SECRET,
    baseURL: process.env.AUTH0_BASE_URL,
    clientID: process.env.AUTH0_CLIENT_ID,
    clientSecret: process.env.AUTH0_CLIENT_SECRET,
    issuerBaseURL: process.env.AUTH0_ISSUER_BASE_URL,
};

app.use(requireAuth(config));

const verifyM2M = checkJwt({
    issuerBaseURL: process.env.AUTH0_ISSUER_BASE_URL,
    audience: process.env.AUTH0_AUDIENCE,
});

const baseUrl = (process.env.AUTH0_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

app.get('/', async (req, res) => {
    try {
        const totalResult = await pool.query('SELECT COUNT(*) FROM passes');
        const activeResult = await pool.query("SELECT COUNT(*) FROM passes WHERE status = 'ACTIVE'");

        const total = totalResult.rows[0].count;
        const active = activeResult.rows[0].count;

        let html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Digitalne propusnice</title>
        <style>
          body { font-family: sans-serif; margin: 20px; }
          table { border-collapse: collapse; width: 100%; margin-top: 15px; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background-color: #f2f2f2; }
          button { padding: 4px 8px; cursor: pointer; }
        </style>
      </head>
      <body>
        <h1>Digitalne propusnice</h1>
        <p>Ukupno propusnica u bazi: ${total}</p>
        <p>Broj aktivnih propusnica: ${active}</p>
        <hr>
    `;

        if (req.oidc.isAuthenticated()) {
            const result = await pool.query('SELECT * FROM passes ORDER BY issued_at DESC');

            html += `
        <p>Prijavljeni ste kao: ${req.oidc.user.email} | <a href="/logout">Odjava</a></p>
        <h2>Popis propusnica</h2>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Ime i prezime</th>
              <th>Broj dokumenta</th>
              <th>Vrijeme izdavanja</th>
              <th>Status</th>
              <th>Akcije</th>
            </tr>
          </thead>
          <tbody>
      `;

            if (result.rows.length === 0) {
                html += `<tr><td colspan="6">Nema propusnica u bazi.</td></tr>`;
            } else {
                result.rows.forEach(p => {
                    const dateStr = p.issued_at instanceof Date ? p.issued_at.toISOString() : p.issued_at;
                    html += `
            <tr>
              <td><a href="/info/${p.id}" target="_blank">${p.id}</a></td>
              <td>${p.name}</td>
              <td>${p.document}</td>
              <td>${dateStr}</td>
              <td>${p.status}</td>
              <td>
                ${p.status === 'ACTIVE' ? `
                  <form action="/passes/${p.id}/cancel" method="POST" style="display:inline;">
                    <button type="submit">Poništi</button>
                  </form>
                ` : 'Poništeno'}
                <form action="/passes/${p.id}/delete" method="POST" style="display:inline; margin-left: 5px;">
                  <button type="submit">Obriši</button>
                </form>
              </td>
            </tr>
          `;
                });
            }

            html += `
          </tbody>
        </table>
      `;
        } else {
            html += `<p><a href="/login">Prijava</a></p>`;
        }

        html += `</body></html>`;
        res.send(html);
    } catch (err) {
        console.error(err);
        res.status(500).send('Greška na poslužitelju');
    }
});

app.post('/passes/:id/cancel', requiresAuth(), async (req, res) => {
    if (!isUuid(req.params.id)) {
        return res.status(404).send('Propusnica ne postoji');
    }
    try {
        await pool.query("UPDATE passes SET status = 'CANCELLED' WHERE id = $1", [req.params.id]);
        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.status(500).send('Greška na poslužitelju');
    }
});

app.post('/passes/:id/delete', requiresAuth(), async (req, res) => {
    if (!isUuid(req.params.id)) {
        return res.status(404).send('Propusnica ne postoji');
    }
    try {
        await pool.query("DELETE FROM passes WHERE id = $1", [req.params.id]);
        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.status(500).send('Greška na poslužitelju');
    }
});

app.get('/info/:id', async (req, res) => {
    if (!isUuid(req.params.id)) {
        return res.status(404).send('Propusnica nije pronađena');
    }

    try {
        const result = await pool.query('SELECT * FROM passes WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).send('Propusnica nije pronađena');
        }

        const p = result.rows[0];
        const dateStr = p.issued_at instanceof Date ? p.issued_at.toISOString() : p.issued_at;

        res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Status propusnice</title>
        <style>body { font-family: sans-serif; margin: 20px; }</style>
      </head>
      <body>
        <h1>Podaci o propusnici</h1>
        <p><strong>Identifikator:</strong> ${p.id}</p>
        <p><strong>Ime i prezime:</strong> ${p.name}</p>
        <p><strong>Oznaka dokumenta:</strong> ${p.document}</p>
        <p><strong>Vrijeme izdavanja:</strong> ${dateStr}</p>
        <p><strong>Status:</strong> ${p.status}</p>
      </body>
      </html>
    `);
    } catch (err) {
        console.error(err);
        res.status(500).send('Greška na poslužitelju');
    }
});

app.get('/passes/:id', verifyM2M, requiredScopes('read:passes'), async (req, res) => {
    if (!isUuid(req.params.id)) {
        return res.status(404).json({ error: 'Not found' });
    }

    try {
        const result = await pool.query('SELECT * FROM passes WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Not found' });
        }

        const p = result.rows[0];
        const issuedAt = p.issued_at instanceof Date ? p.issued_at.toISOString() : p.issued_at;

        res.json({
            id: p.id,
            name: p.name,
            document: p.document,
            issuedAt: issuedAt,
            status: p.status
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/passes', verifyM2M, requiredScopes('create:passes'), async (req, res) => {
    const { name, document } = req.body || {};
    if (!name || !document || typeof name !== 'string' || typeof document !== 'string' || !name.trim() || !document.trim()) {
        return res.status(400).json({ error: 'Bad request' });
    }

    const id = uuidv4();
    const issuedAt = new Date().toISOString();
    const status = 'ACTIVE';

    try {
        await pool.query(
            'INSERT INTO passes (id, name, document, issued_at, status) VALUES ($1, $2, $3, $4, $5)',
            [id, name.trim(), document.trim(), issuedAt, status]
        );

        const publicUrl = `${baseUrl}/info/${id}`;
        const qrImageBuffer = await QRCode.toBuffer(publicUrl);

        res.setHeader('Location', `${baseUrl}/passes/${id}`);
        res.status(201).type('image/png').send(qrImageBuffer);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.use((err, req, res, next) => {
    if (err.headers) {
        res.set(err.headers);
    }
    if (err.name === 'UnauthorizedError' || err.status === 401) {
        return res.status(401).json({ error: 'Unauthorized', message: err.message });
    }
    if (err.name === 'InsufficientScopeError' || err.status === 403) {
        return res.status(403).json({ error: 'Forbidden', message: err.message });
    }
    console.error(err);
    res.status(err.status || 500).json({ error: 'Server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
