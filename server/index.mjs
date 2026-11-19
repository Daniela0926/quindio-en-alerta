import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 8000);
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'tarea3_deslizamientos_quindio',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
});

app.use(express.json());
app.use(express.static(publicDir));

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function dateRange(query) {
  const start = query.desde;
  const end = query.hasta;
  if ((start && !validDate(start)) || (end && !validDate(end))) {
    const error = new Error('Las fechas deben tener formato AAAA-MM-DD.');
    error.status = 400;
    throw error;
  }
  if (start && end && start > end) {
    const error = new Error('La fecha inicial no puede ser posterior a la final.');
    error.status = 400;
    throw error;
  }
  return { start: start || '1900-01-01', end: end || '2999-12-31' };
}

function featureCollection(rows) {
  return {
    type: 'FeatureCollection',
    features: rows.map((row) => ({
      type: 'Feature',
      geometry: row.geometry,
      properties: row.properties,
    })),
  };
}

app.get('/api/health', async (_req, res, next) => {
  try {
    const result = await pool.query('SELECT current_database() AS database, postgis_full_version() AS postgis');
    res.json({ ok: true, ...result.rows[0] });
  } catch (error) { next(error); }
});

app.get('/api/config', async (_req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT (SELECT MIN(fecha) FROM alertas_deslizamiento) AS fecha_inicio,
             (SELECT MAX(fecha) FROM alertas_deslizamiento) AS fecha_fin,
             (SELECT COUNT(*) FROM municipios) AS municipios,
             (SELECT COUNT(*) FROM alertas_deslizamiento) AS alertas,
             (SELECT COUNT(*) FROM precipitacion_diaria) AS dias_lluvia`);
    res.json(result.rows[0]);
  } catch (error) { next(error); }
});

app.get('/api/alertas', async (req, res, next) => {
  try {
    const { start, end } = dateRange(req.query);
    const level = req.query.nivelMinimo === undefined || req.query.nivelMinimo === ''
      ? null : Number(req.query.nivelMinimo);
    if (level !== null && (!Number.isInteger(level) || level < 0 || level > 3)) {
      return res.status(400).json({ error: 'El nivel mínimo debe estar entre 0 y 3.' });
    }
    const result = await pool.query(`
      SELECT ST_AsGeoJSON(m.geom)::json AS geometry,
             json_build_object(
               'codigo', m.codigo_dane, 'municipio', m.nombre,
               'nivel', f.nivel, 'nivel_nombre', COALESCE(n.nombre, 'Sin registro'),
               'color', COALESCE(n.color, '#A8B0B8'), 'fecha', f.fecha,
               'area_km2', m.area_km2, 'altitud_m', m.altitud_m,
               'lluvia_3d_mm', f.lluvia_acumulada_3d,
               'lluvia_10d_mm', f.lluvia_acumulada_10d,
               'dias_con_lluvia', f.dias_con_lluvia
             ) AS properties
      FROM municipios m
      LEFT JOIN (
        SELECT a.municipio_codigo, a.nivel, a.fecha, a.lluvia_acumulada_3d,
               a.lluvia_acumulada_10d, a.dias_con_lluvia,
               ROW_NUMBER() OVER (PARTITION BY a.municipio_codigo ORDER BY a.fecha DESC) AS orden
        FROM alertas_deslizamiento a
        WHERE a.fecha BETWEEN $1::date AND $2::date
          AND ($3::smallint IS NULL OR a.nivel >= $3::smallint)
      ) f ON f.municipio_codigo = m.codigo_dane AND f.orden = 1
      LEFT JOIN niveles_alerta n ON n.nivel = f.nivel
      ORDER BY m.nombre`, [start, end, level]);
    res.json(featureCollection(result.rows));
  } catch (error) { next(error); }
});

app.get('/api/resumen', async (req, res, next) => {
  try {
    const { start, end } = dateRange(req.query);
    const result = await pool.query(`
      WITH ultimas AS (
        SELECT DISTINCT ON (municipio_codigo) municipio_codigo, nivel, fecha
        FROM alertas_deslizamiento
        WHERE fecha BETWEEN $1::date AND $2::date
        ORDER BY municipio_codigo, fecha DESC
      ), lluvia AS (
        SELECT municipio_codigo, AVG(precipitacion_mm) AS promedio
        FROM precipitacion_diaria
        WHERE fecha BETWEEN $1::date AND $2::date
        GROUP BY municipio_codigo
      )
      SELECT COUNT(*)::int AS municipios,
             COUNT(*) FILTER (WHERE u.nivel >= 2)::int AS alerta_media_alta,
             COUNT(*) FILTER (WHERE u.nivel = 3)::int AS alerta_nivel_3,
             ROUND(AVG(l.promedio)::numeric, 1) AS lluvia_media_mm
      FROM municipios m
      LEFT JOIN ultimas u ON u.municipio_codigo = m.codigo_dane
      LEFT JOIN lluvia l ON l.municipio_codigo = m.codigo_dane`, [start, end]);
    res.json(result.rows[0]);
  } catch (error) { next(error); }
});

app.get('/api/municipios/:codigo', async (req, res, next) => {
  try {
    const { start, end } = dateRange(req.query);
    const municipality = await pool.query(`
      SELECT codigo_dane, nombre, departamento, area_km2, altitud_m
      FROM municipios WHERE codigo_dane = $1`, [req.params.codigo]);
    if (!municipality.rowCount) return res.status(404).json({ error: 'Municipio no encontrado.' });
    const history = await pool.query(`
      SELECT a.fecha, a.nivel, n.nombre AS nivel_nombre, n.color,
             p.precipitacion_mm, a.lluvia_acumulada_3d,
             a.lluvia_acumulada_10d, a.dias_con_lluvia
      FROM alertas_deslizamiento a
      JOIN niveles_alerta n ON n.nivel = a.nivel
      LEFT JOIN precipitacion_diaria p
        ON p.municipio_codigo = a.municipio_codigo AND p.fecha = a.fecha
      WHERE a.municipio_codigo = $1 AND a.fecha BETWEEN $2::date AND $3::date
      ORDER BY a.fecha`, [req.params.codigo, start, end]);
    const rain = await pool.query(`
      SELECT fecha, precipitacion_mm FROM precipitacion_diaria
      WHERE municipio_codigo = $1 AND fecha BETWEEN $2::date AND $3::date
      ORDER BY fecha`, [req.params.codigo, start, end]);
    res.json({ municipio: municipality.rows[0], historial_alertas: history.rows, precipitacion: rain.rows });
  } catch (error) { next(error); }
});

app.get('/api/espacial', async (req, res, next) => {
  try {
    const lon = Number(req.query.lon);
    const lat = Number(req.query.lat);
    const date = req.query.fecha;
    if (!Number.isFinite(lon) || lon < -180 || lon > 180 || !Number.isFinite(lat) || lat < -90 || lat > 90) {
      return res.status(400).json({ error: 'Coordenadas inválidas.' });
    }
    if (!validDate(date)) return res.status(400).json({ error: 'Indica la fecha de consulta con formato AAAA-MM-DD.' });
    const result = await pool.query(`
      SELECT m.codigo_dane AS codigo, m.nombre AS municipio,
             m.departamento, a.nivel, n.nombre AS nivel_nombre,
             a.fecha, p.precipitacion_mm,
             a.lluvia_acumulada_3d, a.lluvia_acumulada_10d, a.dias_con_lluvia,
             ST_Covers(m.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)) AS punto_en_municipio
      FROM municipios m
      LEFT JOIN alertas_deslizamiento a
        ON a.municipio_codigo = m.codigo_dane AND a.fecha = $3::date
      LEFT JOIN niveles_alerta n ON n.nivel = a.nivel
      LEFT JOIN precipitacion_diaria p
        ON p.municipio_codigo = m.codigo_dane AND p.fecha = $3::date
      WHERE ST_Covers(m.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
      LIMIT 1`, [lon, lat, date]);
    res.json({ fecha: date, resultado: result.rows[0] || null });
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  console.error(error.message);
  res.status(error.status || 500).json({ error: error.status ? error.message : 'Ocurrió un error al consultar la geodatabase.' });
});

const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Visor SIG listo en http://127.0.0.1:${port}`);
});

// Mantiene activo el proceso en entornos Windows que cierran procesos de Node
// cuando el único recurso abierto es el socket HTTP.
const keepAlive = setInterval(() => {}, 60_000);
server.on('error', (error) => {
  console.error(`No se pudo iniciar el servidor: ${error.message}`);
  clearInterval(keepAlive);
  process.exitCode = 1;
});

process.on('SIGINT', async () => {
  clearInterval(keepAlive);
  server.close();
  await pool.end();
  process.exit(0);
});
