/**
 * PC Nest Speaker - Renderer Process
 * Handles UI interactions and communicates with main process via IPC
 */

// DOM Elements
const statusIndicator = document.getElementById('status-indicator');
const speakerList = document.getElementById('speaker-list');
const discoverBtn = document.getElementById('discover-btn');
const streamBtn = document.getElementById('stream-btn');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const businessLink = document.getElementById('business-link');

// State
let speakers = [];
let selectedSpeaker = null;
let isStreaming = false;

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  // Check current status
  const status = await window.api.getStatus();
  if (status.isStreaming) {
    setStreamingState(true);
  }

  // Set up event listeners
  setupEventListeners();
});

function setupEventListeners() {
  discoverBtn.addEventListener('click', discoverSpeakers);
  streamBtn.addEventListener('click', toggleStreaming);
  businessLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.api.openExternal('https://choppedonions.xyz');
  });

  // Listen for status updates from main process
  window.api.onStreamingStatus((status) => {
    setStreamingState(status.isStreaming);
  });

  window.api.onError((error) => {
    showError(error);
  });
}

async function discoverSpeakers() {
  showLoading('Discovering speakers...');

  try {
    const result = await window.api.discoverSpeakers();

    if (result.success) {
      speakers = result.speakers;
      renderSpeakers();
    } else {
      showError(result.error || 'Failed to discover speakers');
    }
  } catch (error) {
    showError(error.message);
  }

  hideLoading();
}

function renderSpeakers() {
  if (speakers.length === 0) {
    speakerList.innerHTML = `
      <div class="empty-state">
        <p>No speakers found on network</p>
        <button class="btn btn-secondary" id="discover-btn">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
          </svg>
          Try Again
        </button>
      </div>
    `;
    document.getElementById('discover-btn').addEventListener('click', discoverSpeakers);
    streamBtn.disabled = true;
    return;
  }

  speakerList.innerHTML = speakers.map((speaker, index) => `
    <div class="speaker-item" data-index="${index}">
      <div class="speaker-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="4" y="2" width="16" height="20" rx="2"/>
          <circle cx="12" cy="14" r="4"/>
          <line x1="12" y1="6" x2="12" y2="6"/>
        </svg>
      </div>
      <div class="speaker-info">
        <div class="speaker-name">${speaker.name}</div>
        <div class="speaker-model">${speaker.model || 'Chromecast'}</div>
      </div>
      <svg class="speaker-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </div>
  `).join('');

  // Add refresh button at the end
  speakerList.innerHTML += `
    <button class="btn btn-secondary" id="refresh-btn" style="margin-top: 8px;">
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M23 4v6h-6M1 20v-6h6"/>
        <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
      </svg>
      Refresh
    </button>
  `;

  // Add click handlers
  speakerList.querySelectorAll('.speaker-item').forEach((item) => {
    item.addEventListener('click', () => selectSpeaker(parseInt(item.dataset.index)));
  });

  document.getElementById('refresh-btn').addEventListener('click', discoverSpeakers);
}

function selectSpeaker(index) {
  selectedSpeaker = speakers[index];

  // Update UI
  speakerList.querySelectorAll('.speaker-item').forEach((item, i) => {
    item.classList.toggle('selected', i === index);
  });

  // Enable stream button
  streamBtn.disabled = false;
}

async function toggleStreaming() {
  if (isStreaming) {
    await stopStreaming();
  } else {
    await startStreaming();
  }
}

async function startStreaming() {
  if (!selectedSpeaker) {
    showError('Please select a speaker first');
    return;
  }

  showLoading('Starting stream...');

  try {
    const result = await window.api.startStreaming(selectedSpeaker.name);

    if (result.success) {
      setStreamingState(true);
    } else {
      showError(result.error || 'Failed to start streaming');
    }
  } catch (error) {
    showError(error.message);
  }

  hideLoading();
}

async function stopStreaming() {
  showLoading('Stopping stream...');

  try {
    const result = await window.api.stopStreaming();

    if (result.success) {
      setStreamingState(false);
    } else {
      showError(result.error || 'Failed to stop streaming');
    }
  } catch (error) {
    showError(error.message);
  }

  hideLoading();
}

function setStreamingState(streaming) {
  isStreaming = streaming;

  // Update status indicator
  statusIndicator.className = 'status-indicator ' + (streaming ? 'streaming' : 'ready');
  statusIndicator.querySelector('.status-text').textContent = streaming ? 'Streaming' : 'Ready';

  // Update button
  streamBtn.innerHTML = streaming ? `
    <svg class="icon" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16"/>
      <rect x="14" y="4" width="4" height="16"/>
    </svg>
    <span>Stop Streaming</span>
  ` : `
    <svg class="icon" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z"/>
    </svg>
    <span>Start Streaming</span>
  `;
}

function showLoading(text) {
  loadingText.textContent = text;
  loadingOverlay.hidden = false;
}

function hideLoading() {
  loadingOverlay.hidden = true;
}

function showError(message) {
  // Update status to error
  statusIndicator.className = 'status-indicator error';
  statusIndicator.querySelector('.status-text').textContent = message;

  // Reset after 5 seconds
  setTimeout(() => {
    if (!isStreaming) {
      statusIndicator.className = 'status-indicator ready';
      statusIndicator.querySelector('.status-text').textContent = 'Ready';
    }
  }, 5000);
}
