const colors = { 0: '#8A949D', 1: '#EBCB46', 2: '#F28C45', 3: '#D94D4D', null: '#D9E1D8' };
const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([4.53, -75.68], 8);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors', maxZoom: 19,
}).addTo(map);

let layer;
let selectedCode = null;
let dateForPoint = null;
let chartSeries = [];
const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'No fue posible consultar el servidor.');
  return data;
}

function rangeQuery() {
  const params = new URLSearchParams();
  if ($('#date-start').value) params.set('desde', $('#date-start').value);
  if ($('#date-end').value) params.set('hasta', $('#date-end').value);
  return params;
}

function setError(message = '') {
  const element = $('#map-error');
  element.hidden = !message;
  element.textContent = message;
}

function styleFeature(feature) {
  const p = feature.properties;
  const color = colors[p.nivel ?? 'null'];
  return { color: '#667c71', weight: 1.1, opacity: .82, fillColor: color, fillOpacity: p.nivel == null ? .34 : .63 };
}

function popupContent(p) {
  const level = p.nivel_nombre || 'Sin alerta reportada';
  const when = p.fecha ? new Date(`${p.fecha}T12:00:00`).toLocaleDateString('es-CO') : 'Sin registro';
  const rain = p.lluvia_3d_mm == null ? '' : `<br>Acumulado IDEAM (3 días): ${Number(p.lluvia_3d_mm).toFixed(1)} mm`;
  return `<div class="popup-title">${escapeHtml(p.municipio)}</div><div class="popup-line">Alerta más reciente: ${escapeHtml(level)}<br>Fecha: ${escapeHtml(when)}${rain}<br>Código DANE: ${escapeHtml(p.codigo)}</div>`;
}

function drawMap(data) {
  if (layer) map.removeLayer(layer);
  layer = L.geoJSON(data, {
    style: styleFeature,
    onEachFeature(feature, featureLayer) {
      const p = feature.properties;
      featureLayer.bindPopup(popupContent(p));
      featureLayer.on('click', (event) => { L.DomEvent.stopPropagation(event); showMunicipality(p.codigo); });
      if (map.getZoom() >= 9) featureLayer.bindTooltip(p.municipio, { permanent: true, direction: 'center', className: 'municipality-label' });
    },
  }).addTo(map);
  if (layer.getBounds().isValid()) map.fitBounds(layer.getBounds(), { padding: [28, 28], maxZoom: 10 });
}

function updateSummary(summary) {
  $('#stat-municipalities').textContent = summary.municipios ?? '—';
  $('#stat-alerts').textContent = summary.alerta_media_alta ?? '—';
  $('#stat-rain').textContent = summary.lluvia_media_mm ?? '—';
}

async function loadMap() {
  setError();
  const params = rangeQuery();
  if ($('#level-filter').value) params.set('nivelMinimo', $('#level-filter').value);
  try {
    const [geojson, summary] = await Promise.all([
      getJson(`/api/alertas?${params}`),
      getJson(`/api/resumen?${rangeQuery()}`),
    ]);
    drawMap(geojson);
    updateSummary(summary);
    $('#period-label').textContent = `${$('#date-start').value} — ${$('#date-end').value}`;
    dateForPoint = $('#date-end').value;
  } catch (error) { setError(error.message); }
}

function drawChart(series) {
  chartSeries = series;
  const canvas = $('#rain-chart');
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(260, rect.width) * dpr;
  canvas.height = 100 * dpr;
  const context = canvas.getContext('2d');
  context.scale(dpr, dpr);
  const width = canvas.width / dpr;
  const height = 100;
  context.clearRect(0, 0, width, height);
  if (!series.length) {
    context.fillStyle = '#8a9690'; context.font = '10px DM Mono';
    context.fillText('Sin datos para el periodo', 5, 48);
    return;
  }
  const visible = series.length > 180 ? series.filter((_, index) => index % Math.ceil(series.length / 180) === 0) : series;
  const values = visible.map((row) => row.precipitacion_mm == null ? null : Number(row.precipitacion_mm)).filter((value) => value != null && Number.isFinite(value));
  const max = Math.max(10, ...values);
  const left = 5; const right = width - 4; const top = 10; const bottom = 78;
  context.strokeStyle = '#e7eae1'; context.lineWidth = 1;
  [0, .5, 1].forEach((fraction) => {
    const y = bottom - fraction * (bottom - top);
    context.beginPath(); context.moveTo(left, y); context.lineTo(right, y); context.stroke();
  });
  context.fillStyle = '#98a59b'; context.font = '9px DM Mono';
  context.fillText(`${max.toFixed(0)} mm`, left, 8); context.fillText('0', left, 91);
  context.beginPath(); context.strokeStyle = '#5e9d87'; context.lineWidth = 1.7;
  let penDown = false;
  visible.forEach((row, index) => {
    const x = left + (index / Math.max(visible.length - 1, 1)) * (right - left);
    if (row.precipitacion_mm == null || !Number.isFinite(Number(row.precipitacion_mm))) { penDown = false; return; }
    const y = bottom - (Number(row.precipitacion_mm) / max) * (bottom - top);
    if (!penDown) context.moveTo(x, y); else context.lineTo(x, y);
    penDown = true;
  });
  context.stroke();
}

function showDetails(municipality, selectedDateRow = null) {
  const p = municipality;
  $('#selection-title').textContent = p.nombre || p.municipio || 'Consulta espacial';
  $('#selection-help').textContent = 'Resumen municipal y serie diaria del periodo seleccionado.';
  const level = selectedDateRow?.nivel == null ? 'Sin alerta reportada' : (selectedDateRow.nivel_nombre || `Nivel ${selectedDateRow.nivel}`);
  const badgeColor = selectedDateRow?.nivel == null ? colors.null : colors[selectedDateRow.nivel];
  $('#municipality-details').innerHTML = `
    <div class="detail-title">${escapeHtml(p.nombre || p.municipio)}</div>
    <div class="detail-row">Código DANE: ${escapeHtml(p.codigo_dane || p.codigo || '')}</div>
    ${p.area_km2 ? `<div class="detail-row">Área: ${Number(p.area_km2).toFixed(1)} km²</div>` : ''}
    ${selectedDateRow?.lluvia_acumulada_3d != null ? `<div class="detail-row">Lluvia IDEAM: ${Number(selectedDateRow.lluvia_acumulada_3d).toFixed(1)} mm (3 días) · ${Number(selectedDateRow.lluvia_acumulada_10d).toFixed(1)} mm (10 días)</div>` : ''}
    <span class="detail-badge"><i style="background:${badgeColor}"></i>${escapeHtml(level)}</span>`;
}

async function showMunicipality(code) {
  selectedCode = code;
  try {
    const params = rangeQuery();
    const data = await getJson(`/api/municipios/${encodeURIComponent(code)}?${params}`);
    const latest = data.historial_alertas.at(-1);
    showDetails(data.municipio, latest);
    $('#chart-title').textContent = data.municipio.nombre;
    drawChart(data.precipitacion);
  } catch (error) { setError(error.message); }
}

async function queryPoint(event) {
  if (!dateForPoint) return;
  try {
    const params = new URLSearchParams({ lon: event.latlng.lng.toFixed(6), lat: event.latlng.lat.toFixed(6), fecha: dateForPoint });
    const data = await getJson(`/api/espacial?${params}`);
    const result = data.resultado;
    if (!result) {
      $('#selection-title').textContent = 'Punto fuera del Quindío';
      $('#selection-help').textContent = 'La operación ST_Covers no encontró un polígono municipal que contenga estas coordenadas.';
      $('#municipality-details').innerHTML = `<div class="detail-row">Longitud ${event.latlng.lng.toFixed(4)} · Latitud ${event.latlng.lat.toFixed(4)}</div>`;
      return;
    }
    if (result.codigo !== selectedCode) await showMunicipality(result.codigo);
    showDetails(result, result);
    $('#selection-help').textContent = `Consulta PostGIS con ST_Covers para el ${new Date(`${data.fecha}T12:00:00`).toLocaleDateString('es-CO')}.`;
    $('#chart-title').textContent = result.municipio;
    map.openPopup(`<div class="popup-title">${escapeHtml(result.municipio)}</div><div class="popup-line">Alerta: ${escapeHtml(result.nivel_nombre || 'Sin registro')}<br>Precipitación estimada: ${result.precipitacion_mm ?? 'Sin dato'} mm</div>`, event.latlng);
  } catch (error) { setError(error.message); }
}

async function initialize() {
  try {
    const [config, health] = await Promise.all([getJson('/api/config'), getJson('/api/health')]);
    $('#date-start').value = String(config.fecha_inicio).slice(0, 10);
    $('#date-end').value = String(config.fecha_fin).slice(0, 10);
    $('#connection-status').textContent = `PostGIS conectado · ${config.municipios} municipios`;
    await loadMap();
    if (config.municipios) {
      const first = await getJson(`/api/alertas?${rangeQuery()}`);
      const firstFeature = first.features?.[0];
      if (firstFeature) await showMunicipality(firstFeature.properties.codigo);
    }
  } catch (error) {
    $('#connection-status').textContent = 'Sin conexión con PostGIS';
    setError(error.message);
  }
}

$('#apply-filters').addEventListener('click', loadMap);
$('#fit-map').addEventListener('click', () => { if (layer?.getBounds().isValid()) map.fitBounds(layer.getBounds(), { padding: [28, 28], maxZoom: 10 }); });
map.on('click', queryPoint);
window.addEventListener('resize', () => { if (chartSeries.length) drawChart(chartSeries); });
initialize();
