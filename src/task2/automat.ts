import { writeFile } from 'node:fs/promises';

export async function getToken(
    authority: string,
    audience: string,
    clientId: string,
    clientSecret: string,
    scope: string
): Promise<string> {
    const cleanAuthority = authority.replace(/\/+$/, '');
    const response = await fetch(`${cleanAuthority}/oauth/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            audience: audience,
            grant_type: 'client_credentials',
            scope: scope
        })
    });

    if (!response.ok) {
        throw new Error(`Greška pri dohvatu tokena: Status ${response.status}`);
    }

    const data = await response.json();
    return data.access_token;
}

export async function issuePass(
    url: string,
    token: string,
    name: string,
    document: string
): Promise<void> {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name, document })
    });

    if (!response.ok) {
        throw new Error(`Greška pri izdavanju propusnice: Status ${response.status}`);
    }

    const locationHeader = response.headers.get('Location');
    if (!locationHeader) {
        throw new Error('Zaglavlje Location nedostaje u odgovoru poslužitelja.');
    }

    const segments = locationHeader.split('/').filter(Boolean);
    const passId = segments[segments.length - 1];

    if (!passId) {
        throw new Error('Nije moguće odrediti identifikator propusnice iz Location zaglavlja.');
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    await writeFile(`${passId}.png`, buffer);
}
