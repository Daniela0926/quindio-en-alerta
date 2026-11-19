import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'tarea3_deslizamientos_quindio',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
});

const alertCsvUrl = 'https://bart.ideam.gov.co/ospa/DatosAbiertos/Alertas_Deslizamientos/alertas_deslizamientos.csv';
const daneLayer = 'https://geoportal.dane.gov.co/mparcgis/rest/services/Divipola/Serv_DIVIPOLA_MGN_2024/FeatureServer/317';
const openMeteo = 'https://archive-api.open-meteo.com/v1/archive';
const levelByName = { BAJA: 1, MODERADA: 2, ALTA: 3 };

function bogotaDate(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function period() {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 7);
  return { start: '2026-01-01', end: bogotaDate(end) };
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'QuindioRiskViewer/1.0 (academic project)' } });
  if (!response.ok) throw new Error(`Fuente devolvió HTTP ${response.status}: ${url}`);
  return response.arrayBuffer();
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'QuindioRiskViewer/1.0 (academic project)' } });
  if (!response.ok) throw new Error(`Fuente devolvió HTTP ${response.status}: ${url}`);
  return response.json();
}

function parseDelimited(text, delimiter = ';') {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell); cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
    } else {
      cell += char;
    }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function ddmmyyyy(value) {
  const [day, month, year] = value.split('/').map(Number);
  if (!day || !month || !year) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function titleCase(value) {
  return value.toLocaleLowerCase('es-CO').replace(/(^|\s)\p{L}/gu, (letter) => letter.toLocaleUpperCase('es-CO'));
}

async function fetchMunicipalities() {
  const query = new URL(`${daneLayer}/query`);
  query.search = new URLSearchParams({
    where: "DPTO_CCDGO = '63'",
    outFields: 'MPIO_CDPMP,MPIO_CNMBRE,MPIO_NAREA,MPIO_NANO',
    returnGeometry: 'true', outSR: '4326', f: 'geojson',
  }).toString();
  const result = await fetchJson(query);
  if (result.error) throw new Error(result.error.message || 'No se pudieron descargar los polígonos DANE.');
  return (result.features || []).map((feature) => ({
    code: String(feature.properties.MPIO_CDPMP),
    name: titleCase(feature.properties.MPIO_CNMBRE),
    department: 'Quindío',
    areaKm2: Number(feature.properties.MPIO_NAREA) || null,
    geometry: feature.geometry,
  }));
}

async function fetchAlertRecords(start, end) {
  const buffer = await fetchText(alertCsvUrl);
  const csv = new TextDecoder('windows-1252').decode(buffer);
  const rows = parseDelimited(csv);
  const headers = rows.shift();
  const index = Object.fromEntries(headers.map((name, i) => [name, i]));
  const records = [];
  const latestDate = new Map();
  for (const values of rows) {
    const code = String(values[index.COD_DANE] || '').trim();
    if (!code.startsWith('63')) continue;
    const date = ddmmyyyy(String(values[index.FECHA_EJECUCION] || '').trim());
    if (!date || date < start || date > end) continue;
    const level = levelByName[String(values[index.TEXTO_AMENAZA] || '').trim().toLocaleUpperCase('es-CO')];
    if (!level) continue;
    const record = {
      code, date, level,
      sourceId: String(values[index.OBJECTID] || ''),
      rainfall3d: Number(values[index.ACUMULADO_TRES]) || 0,
      rainfall10d: Number(values[index.ACUMULADO_DIEZ]) || 0,
      rainyDays: Number(values[index.DIAS_LLUVIA]) || 0,
    };
    records.push(record);
    if (!latestDate.has(code) || date > latestDate.get(code)) latestDate.set(code, date);
  }
  return { records, latestDate };
}

async function storeMunicipalities(rows) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      await client.query(`
        INSERT INTO municipios (codigo_dane, nombre, departamento, area_km2, geom, fuente)
        VALUES ($1, $2, $3, $4, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($5), 4326)), $6)
        ON CONFLICT (codigo_dane) DO UPDATE SET
          nombre = EXCLUDED.nombre, departamento = EXCLUDED.departamento,
          area_km2 = EXCLUDED.area_km2, geom = EXCLUDED.geom, fuente = EXCLUDED.fuente`,
      [row.code, row.name, row.department, row.areaKm2, JSON.stringify(row.geometry), 'DANE MGN 2024']);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function storeAlerts(rows) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      await client.query(`
        INSERT INTO alertas_deslizamiento
          (municipio_codigo, nivel, fecha, fuente_id, lluvia_acumulada_3d, lluvia_acumulada_10d, dias_con_lluvia)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (municipio_codigo, fecha) DO UPDATE SET
          nivel = EXCLUDED.nivel, fuente_id = EXCLUDED.fuente_id,
          lluvia_acumulada_3d = EXCLUDED.lluvia_acumulada_3d,
          lluvia_acumulada_10d = EXCLUDED.lluvia_acumulada_10d,
          dias_con_lluvia = EXCLUDED.dias_con_lluvia`,
      [row.code, row.level, row.date, row.sourceId || null, row.rainfall3d, row.rainfall10d, row.rainyDays]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function fetchPrecipitation(municipality, start, end) {
  const point = await pool.query(`
    SELECT ST_Y(ST_PointOnSurface(geom)) AS lat,
           ST_X(ST_PointOnSurface(geom)) AS lon
    FROM municipios WHERE codigo_dane = $1`, [municipality.code]);
  if (!point.rowCount) return [];
  const { lat, lon } = point.rows[0];
  const url = new URL(openMeteo);
  url.search = new URLSearchParams({
    latitude: String(lat), longitude: String(lon), start_date: start, end_date: end,
    daily: 'precipitation_sum', timezone: 'America/Bogota', models: 'ecmwf_ifs',
  }).toString();
  const result = await fetchJson(url);
  const times = result.daily?.time || [];
  const amounts = result.daily?.precipitation_sum || [];
  return times.map((date, i) => ({ code: municipality.code, date, mm: amounts[i] }));
}

async function storePrecipitation(rows) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      await client.query(`
        INSERT INTO precipitacion_diaria (municipio_codigo, fecha, precipitacion_mm)
        VALUES ($1, $2, $3)
        ON CONFLICT (municipio_codigo, fecha) DO UPDATE SET
          precipitacion_mm = EXCLUDED.precipitacion_mm,
          modelo = 'ECMWF IFS (histórico)'`, [row.code, row.date, row.mm]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

try {
  const { start, end } = period();
  console.log(`Periodo común de carga: ${start} a ${end}.`);
  const [municipalities, { records }] = await Promise.all([
    fetchMunicipalities(), fetchAlertRecords(start, end),
  ]);
  if (municipalities.length !== 12) throw new Error(`DANE devolvió ${municipalities.length} municipios; se esperaban 12.`);
  if (!records.length) throw new Error('No se encontraron alertas del Quindío en el periodo.');
  const availableCodes = new Set(municipalities.map((row) => row.code));
  const alerts = records.filter((row) => availableCodes.has(row.code));
  await storeMunicipalities(municipalities);
  await storeAlerts(alerts);
  console.log(`Cargados ${municipalities.length} polígonos DANE y ${alerts.length} alertas IDEAM.`);

  for (const municipality of municipalities) {
    const rows = await fetchPrecipitation(municipality, start, end);
    const validRows = rows.filter((row) => row.mm != null && Number.isFinite(Number(row.mm)));
    if (!validRows.length) throw new Error(`La fuente no devolvió precipitación con valores para ${municipality.name}.`);
    await storePrecipitation(rows);
    console.log(`Cargados ${validRows.length} días con precipitación para ${municipality.name}.`);
  }
  console.log('Carga completada.');
} catch (error) {
  console.error('Error durante la carga:', error.message);
  process.exitCode = 1;
} finally { await pool.end(); }
