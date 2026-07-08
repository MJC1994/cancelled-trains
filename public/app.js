const CONCURRENCY = 8;

const limitSelect = document.getElementById('limit-select');
const operatorSelect = document.getElementById('operator-select');
const refreshBtn = document.getElementById('refresh-btn');
const summaryEl = document.getElementById('summary');
const progressEl = document.getElementById('progress');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const filterStatusEl = document.getElementById('filter-status');
const errorEl = document.getElementById('error');
const trainsEl = document.getElementById('trains');

const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/London',
});

let loadToken = 0;
let knownOperators = new Set();

limitSelect.addEventListener('change', () => loadTrains());
operatorSelect.addEventListener('change', () => applyOperatorFilter());
refreshBtn.addEventListener('click', () => loadTrains());

loadTrains();

async function loadTrains() {
  const token = ++loadToken;
  const limit = limitSelect.value;

  refreshBtn.disabled = true;
  operatorSelect.disabled = true;
  knownOperators = new Set();
  rebuildOperatorSelect();
  filterStatusEl.classList.add('hidden');
  filterStatusEl.textContent = '';
  errorEl.classList.add('hidden');
  errorEl.textContent = '';
  trainsEl.innerHTML = '';
  progressEl.classList.add('hidden');
  summaryEl.innerHTML = '<div class="summary-loading">Loading cancelled trains…</div>';

  try {
    const res = await fetch(`/api/cancelled?limit=${encodeURIComponent(limit)}`);
    if (!res.ok) {
      throw new Error(`Failed to load cancelled trains (${res.status})`);
    }

    const data = await res.json();
    if (token !== loadToken) return;

    const services = sortServicesByDeparture(data.services || [], data.date);
    renderSummary(data, services.length);

    if (services.length === 0) {
      trainsEl.innerHTML = '<p class="summary-note">No cancelled trains found.</p>';
      return;
    }

    progressEl.classList.remove('hidden');
    updateProgress(0, services.length);

    const cards = services.map((service) => createTrainCard(service));
    trainsEl.append(...cards);

    let loaded = 0;
    const enriched = new Array(services.length);
    await mapWithConcurrency(services, CONCURRENCY, async (service, index) => {
      if (token !== loadToken) return;

      const result = await fetchServiceDetails(service.rid);
      if (token !== loadToken) return;

      enriched[index] = { service, result };
      updateTrainCard(cards[index], service, result);
      loaded += 1;
      updateProgress(loaded, services.length);
    });

    if (token === loadToken && enriched.every(Boolean)) {
      reorderTrainCards(services, enriched, cards, data.date);
      applyOperatorFilter();
    }
  } catch (err) {
    if (token !== loadToken) return;
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
    summaryEl.innerHTML = '';
  } finally {
    if (token === loadToken) {
      refreshBtn.disabled = false;
      operatorSelect.disabled = knownOperators.size === 0;
    }
  }
}

function renderSummary(data, loadedCount) {
  const limit = Number(limitSelect.value);
  const totalCancelled = data.cancelledServices ?? loadedCount;

  summaryEl.innerHTML = `
    <dl class="summary-grid">
      <div class="summary-item">
        <dt>Date</dt>
        <dd>${escapeHtml(data.date || '—')}</dd>
      </div>
      <div class="summary-item">
        <dt>Total cancelled</dt>
        <dd>${totalCancelled}</dd>
      </div>
      <div class="summary-item">
        <dt>Loaded</dt>
        <dd>${loadedCount}</dd>
      </div>
    </dl>
    <p class="summary-note">
      Showing up to ${limit} of ${totalCancelled} cancelled services (API cap: 500).
    </p>
  `;
}

function createTrainCard(service) {
  const card = document.createElement('article');
  card.className = 'train-card';
  card.dataset.rid = service.rid;
  card.dataset.operator = service.toc || '';

  const departure = getDepartureTime(service, null);
  const reason = getCancelReason(service, null);

  card.innerHTML = `
    <button class="train-summary" type="button" aria-expanded="false">
      <div class="train-main">
        <div class="train-top-row">
          <div class="route">${escapeHtml(service.origin || '?')} → ${escapeHtml(service.destination || '?')}</div>
          <div class="train-top-actions">
            <span class="badge loading">Loading journey…</span>
            <span class="expand-icon" aria-hidden="true">▾</span>
          </div>
        </div>
        <div class="train-meta">
          <span>Departs ${escapeHtml(departure)}</span>
        </div>
        ${reason ? `<div class="cancel-reason">${escapeHtml(reason)}</div>` : ''}
      </div>
    </button>
    <div class="train-details hidden"></div>
  `;

  const summaryBtn = card.querySelector('.train-summary');
  const detailsEl = card.querySelector('.train-details');

  summaryBtn.addEventListener('click', () => {
    const expanded = summaryBtn.getAttribute('aria-expanded') === 'true';
    summaryBtn.setAttribute('aria-expanded', String(!expanded));
    detailsEl.classList.toggle('hidden', expanded);
    summaryBtn.querySelector('.expand-icon').textContent = expanded ? '▾' : '▴';
  });

  return card;
}

function updateTrainCard(card, service, result) {
  const badge = card.querySelector('.badge');
  const metaEl = card.querySelector('.train-meta');
  const reasonEl = card.querySelector('.cancel-reason');
  const detailsEl = card.querySelector('.train-details');

  const board = result.ok ? result.data : null;
  const cancelledCount = getCancelledStopCount(service, board);
  const operator = getOperator(service, board);

  card.dataset.operator = operator;
  noteOperator(operator);

  badge.classList.remove('loading');
  if (result.ok) {
    badge.textContent = `${cancelledCount} stops cancelled`;
  } else {
    badge.classList.add('error');
    badge.textContent = 'Journey details unavailable';
  }

  const departure = getDepartureTime(service, board);
  metaEl.innerHTML = `<span>Departs ${escapeHtml(departure)}</span>`;

  const reason = getCancelReason(service, board);
  if (reason) {
    if (reasonEl) {
      reasonEl.textContent = reason;
    } else {
      const main = card.querySelector('.train-main');
      const el = document.createElement('div');
      el.className = 'cancel-reason';
      el.textContent = reason;
      main.appendChild(el);
    }
  }

  detailsEl.innerHTML = renderDetails(service, board, result);

  if (operatorSelect.value) {
    applyOperatorFilter();
  }
}

function renderDetails(service, board, result) {
  let html = '';

  if (!result.ok) {
    html += `<div class="detail-error">Could not load journey details: ${escapeHtml(result.error)}</div>`;
  }

  if (board?.locations?.length) {
    html += `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Station</th>
              <th>Platform</th>
              <th>Scheduled arr</th>
              <th>Scheduled dep</th>
              <th>Estimated</th>
              <th>Actual</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${board.locations.map((loc) => renderLocationRow(loc)).join('')}
          </tbody>
        </table>
      </div>
    `;
  } else if (service.cancelledStops?.length) {
    html += `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Station</th>
              <th>Scheduled arr</th>
              <th>Scheduled dep</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${service.cancelledStops.map((stop) => `
              <tr class="cancelled">
                <td>${escapeHtml(stop.stationName || stop.tiploc || '—')}</td>
                <td>${escapeHtml(stop.scheduledArrival || '—')}</td>
                <td>${escapeHtml(stop.scheduledDeparture || '—')}</td>
                <td class="status-cancelled">Cancelled</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  return html || '<p class="summary-note">No calling point data available.</p>';
}

function renderLocationRow(loc) {
  const cancelled = loc.isCancelled === true;
  const delayed = loc.isDelayed === true;
  let status = 'On time';
  let statusClass = 'status-ok';

  if (cancelled) {
    status = 'Cancelled';
    statusClass = 'status-cancelled';
  } else if (delayed) {
    status = 'Delayed';
    statusClass = '';
  }

  return `
    <tr class="${cancelled ? 'cancelled' : ''}">
      <td>${escapeHtml(loc.locationName || '—')}</td>
      <td>${escapeHtml(loc.platform ?? '—')}</td>
      <td>${formatTime(loc.sta)}</td>
      <td>${formatTime(loc.std)}</td>
      <td>${formatTime(loc.eta || loc.etd)}</td>
      <td>${formatTime(loc.ata || loc.atd)}</td>
      <td class="${statusClass}">${status}</td>
    </tr>
  `;
}

async function fetchServiceDetails(rid) {
  try {
    const res = await fetch(`/api/service/${encodeURIComponent(rid)}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body.error || `HTTP ${res.status}` };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function getDepartureTime(service, board) {
  const boardDep = board?.locations?.find((loc) => loc.std)?.std;
  if (boardDep) return formatTime(boardDep);

  const stopDep = service.cancelledStops?.find((s) => s.scheduledDeparture)?.scheduledDeparture;
  if (stopDep) return stopDep;

  return '—';
}

function getDepartureSortMs(service, board, dateStr) {
  const boardDep = board?.locations?.find((loc) => loc.std)?.std;
  if (boardDep) {
    const ms = Date.parse(boardDep);
    if (!Number.isNaN(ms)) return ms;
  }

  const stopDep = service.cancelledStops?.find((s) => s.scheduledDeparture)?.scheduledDeparture;
  if (stopDep && dateStr) {
    const ms = Date.parse(`${dateStr}T${stopDep}:00`);
    if (!Number.isNaN(ms)) return ms;
  }

  return Infinity;
}

function sortServicesByDeparture(services, dateStr) {
  return [...services].sort(
    (a, b) => getDepartureSortMs(a, null, dateStr) - getDepartureSortMs(b, null, dateStr)
  );
}

function reorderTrainCards(services, enriched, cards, dateStr) {
  const order = services
    .map((service, index) => ({
      card: cards[index],
      sortMs: getDepartureSortMs(service, enriched[index].result.ok ? enriched[index].result.data : null, dateStr),
    }))
    .sort((a, b) => a.sortMs - b.sortMs);

  trainsEl.replaceChildren(...order.map((entry) => entry.card));
}

function getCancelReason(service, board) {
  return (
    board?.cancelReason ||
    board?.bulletin ||
    board?.delayReason ||
    (service.cancelReason ? `Reason code: ${service.cancelReason}` : null)
  );
}

function getOperator(service, board) {
  return board?.operator || service.toc || 'Unknown';
}

function noteOperator(operator) {
  if (!operator || knownOperators.has(operator)) return;
  knownOperators.add(operator);
  rebuildOperatorSelect();
  operatorSelect.disabled = false;
}

function rebuildOperatorSelect() {
  const current = operatorSelect.value;
  const operators = [...knownOperators].sort((a, b) => a.localeCompare(b));

  operatorSelect.innerHTML = '<option value="">All operators</option>' +
    operators.map((operator) => `<option value="${escapeHtml(operator)}">${escapeHtml(operator)}</option>`).join('');

  if (operators.includes(current)) {
    operatorSelect.value = current;
  }
}

function applyOperatorFilter() {
  const selected = operatorSelect.value;
  const cards = [...trainsEl.querySelectorAll('.train-card')];
  let visible = 0;

  cards.forEach((card) => {
    const match = !selected || card.dataset.operator === selected;
    card.classList.toggle('hidden', !match);
    if (match) visible += 1;
  });

  if (selected) {
    filterStatusEl.textContent = `Showing ${visible} ${visible === 1 ? 'journey' : 'journeys'} for ${selected}`;
    filterStatusEl.classList.remove('hidden');
  } else {
    filterStatusEl.classList.add('hidden');
    filterStatusEl.textContent = '';
  }

  const emptyMessage = trainsEl.querySelector('.filter-empty');
  if (selected && visible === 0 && cards.length > 0) {
    if (!emptyMessage) {
      const el = document.createElement('p');
      el.className = 'summary-note filter-empty';
      el.textContent = `No cancelled journeys found for ${selected}.`;
      trainsEl.appendChild(el);
    }
  } else if (emptyMessage) {
    emptyMessage.remove();
  }
}

function getCancelledStopCount(service, board) {
  if (board?.locations?.length) {
    return board.locations.filter((loc) => loc.isCancelled === true).length;
  }

  return service.cancelledStopCount ?? service.cancelledStops?.length ?? 0;
}

function formatTime(value) {
  if (!value) return '—';
  if (/^\d{2}:\d{2}$/.test(value)) return value;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return timeFormatter.format(date);
}

function updateProgress(loaded, total) {
  const pct = total === 0 ? 0 : Math.round((loaded / total) * 100);
  progressFill.style.width = `${pct}%`;
  progressText.textContent = `Loaded ${loaded} / ${total} journey details`;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = index++;
      results[current] = await fn(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
