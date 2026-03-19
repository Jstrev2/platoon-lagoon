// ===== THE PLATOON LAGOON =====

const MLB_API = 'https://statsapi.mlb.com/api/v1';
const LOGO_URL = (id) => `https://www.mlbstatic.com/team-logos/${id}.svg`;

let currentDate = new Date();
let currentGame = null;
let picks = { away: new Set(), home: new Set() };
let rosterCache = {};

// ===== DATE HELPERS =====
function formatDate(d) {
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function apiDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function gameTime(iso) {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
    // Try to use Chicago time for default
    const now = new Date();
    currentDate = now;
    loadGames();
});

function changeDate(delta) {
    currentDate.setDate(currentDate.getDate() + delta);
    loadGames();
}

// ===== LOAD GAMES =====
async function loadGames() {
    showLoading(true);
    document.getElementById('current-date').textContent = formatDate(currentDate);
    
    try {
        const dateStr = apiDate(currentDate);
        const resp = await fetch(`${MLB_API}/schedule?date=${dateStr}&sportId=1&hydrate=probablePitcher(note),team,linescore`);
        const data = await resp.json();
        
        const games = data.dates?.[0]?.games || [];
        renderGames(games);
    } catch (err) {
        console.error('Failed to load games:', err);
        document.getElementById('games-grid').innerHTML = '<p class="no-games">🌊 Tide\'s out. Couldn\'t reach the MLB API.</p>';
    }
    
    showLoading(false);
    showView('games');
}

function renderGames(games) {
    const grid = document.getElementById('games-grid');
    const noGames = document.getElementById('no-games');
    
    if (games.length === 0) {
        grid.innerHTML = '';
        noGames.style.display = 'block';
        return;
    }
    
    noGames.style.display = 'none';
    
    grid.innerHTML = games.map(g => {
        const away = g.teams.away;
        const home = g.teams.home;
        const awayP = g.teams.away.probablePitcher;
        const homeP = g.teams.home.probablePitcher;
        
        const state = g.status.abstractGameState;
        let statusClass = 'preview';
        let statusText = gameTime(g.gameDate);
        if (state === 'Live') { statusClass = 'live'; statusText = 'LIVE'; }
        if (state === 'Final') { statusClass = 'final'; statusText = 'FINAL'; }
        
        return `
        <div class="game-card" onclick="loadGame(${g.gamePk})">
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <span class="game-status ${statusClass}">${statusText}</span>
                <span style="font-size:11px;color:var(--text-light);">${g.gameType === 'S' ? 'Spring Training' : g.gameType === 'R' ? 'Regular Season' : g.gameType}</span>
            </div>
            <div class="game-card-teams" style="margin-top:10px;">
                <div class="game-card-team">
                    <img class="team-logo" src="${LOGO_URL(away.team.id)}" alt="${away.team.teamName}" onerror="this.style.display='none'">
                    <div>
                        <div class="team-name">${away.team.teamName}</div>
                        <div class="team-record">${away.leagueRecord ? `${away.leagueRecord.wins}-${away.leagueRecord.losses}` : ''}</div>
                    </div>
                </div>
                <div class="game-card-vs">@</div>
                <div class="game-card-team" style="text-align:right;justify-content:flex-end;">
                    <div>
                        <div class="team-name">${home.team.teamName}</div>
                        <div class="team-record">${home.leagueRecord ? `${home.leagueRecord.wins}-${home.leagueRecord.losses}` : ''}</div>
                    </div>
                    <img class="team-logo" src="${LOGO_URL(home.team.id)}" alt="${home.team.teamName}" onerror="this.style.display='none'">
                </div>
            </div>
            <div class="game-card-pitchers">
                <div>
                    ${awayP ? `<span class="pitcher-name">${awayP.fullName}</span><span class="pitcher-hand ${awayP.pitchHand?.code || ''}">${awayP.pitchHand?.code || '?'}HP</span>` : '<span style="opacity:0.5">TBD</span>'}
                </div>
                <div>
                    ${homeP ? `<span class="pitcher-name">${homeP.fullName}</span><span class="pitcher-hand ${homeP.pitchHand?.code || ''}">${homeP.pitchHand?.code || '?'}HP</span>` : '<span style="opacity:0.5">TBD</span>'}
                </div>
            </div>
        </div>`;
    }).join('');
}

// ===== LOAD GAME DETAIL =====
async function loadGame(gamePk) {
    showLoading(true);
    picks = { away: new Set(), home: new Set() };
    
    try {
        // Get game feed
        const feedResp = await fetch(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`);
        const feed = await feedResp.json();
        
        currentGame = feed;
        
        const gd = feed.gameData;
        const awayId = gd.teams.away.id;
        const homeId = gd.teams.home.id;
        
        // Get rosters with hydrated player info
        const [awayRoster, homeRoster] = await Promise.all([
            fetchRoster(awayId),
            fetchRoster(homeId)
        ]);
        
        // Get actual lineup if game has started
        const awayLineup = feed.liveData?.boxscore?.teams?.away?.battingOrder || [];
        const homeLineup = feed.liveData?.boxscore?.teams?.home?.battingOrder || [];
        
        // Get probable pitchers
        const awayPitcher = gd.probablePitchers?.away;
        const homePitcher = gd.probablePitchers?.home;
        
        renderGameDetail(gd, awayRoster, homeRoster, awayPitcher, homePitcher, awayLineup, homeLineup);
    } catch (err) {
        console.error('Failed to load game:', err);
    }
    
    showLoading(false);
    showView('game');
}

async function fetchRoster(teamId) {
    if (rosterCache[teamId]) return rosterCache[teamId];
    
    try {
        const resp = await fetch(`${MLB_API}/teams/${teamId}/roster?rosterType=active&hydrate=person(stats(type=season,season=2026,gameType=R),currentTeam)`);
        const data = await resp.json();
        rosterCache[teamId] = data.roster || [];
        return rosterCache[teamId];
    } catch {
        // Fallback to 40-man
        const resp = await fetch(`${MLB_API}/teams/${teamId}/roster?rosterType=40Man&hydrate=person(stats(type=season),currentTeam)`);
        const data = await resp.json();
        rosterCache[teamId] = data.roster || [];
        return rosterCache[teamId];
    }
}

function renderGameDetail(gd, awayRoster, homeRoster, awayPitcher, homePitcher, awayLineup, homeLineup) {
    const state = gd.status.abstractGameState;
    const hasLineup = awayLineup.length > 0 || homeLineup.length > 0;
    
    // Game header
    document.getElementById('game-header').innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;gap:20px;">
            <img class="team-logo" src="${LOGO_URL(gd.teams.away.id)}" style="width:50px;height:50px;" onerror="this.style.display='none'">
            <div>
                <div style="font-weight:700;font-size:18px;">${gd.teams.away.name} @ ${gd.teams.home.name}</div>
                <div style="font-size:13px;color:var(--text-light);">${gameTime(gd.datetime.dateTime)} · ${gd.venue?.name || ''}</div>
            </div>
            <img class="team-logo" src="${LOGO_URL(gd.teams.home.id)}" style="width:50px;height:50px;" onerror="this.style.display='none'">
        </div>
    `;
    
    // Matchup info with pitchers
    const awayHand = awayPitcher?.pitchHand?.code || '?';
    const homeHand = homePitcher?.pitchHand?.code || '?';
    
    document.getElementById('matchup-info').innerHTML = `
        <h3>⚾ Pitching Matchup</h3>
        <div class="matchup-pitcher">
            <div class="side">
                <div class="name">${awayPitcher?.fullName || 'TBD'}</div>
                <span class="hand-badge ${awayHand}">${awayHand === 'L' ? '🫲 Lefty' : awayHand === 'R' ? '🫱 Righty' : awayHand === 'S' ? '🔄 Switch' : '❓ TBD'}</span>
                <div style="font-size:11px;margin-top:4px;opacity:0.7">Pitching for ${gd.teams.away.teamName}</div>
            </div>
            <div style="font-size:20px;">vs</div>
            <div class="side">
                <div class="name">${homePitcher?.fullName || 'TBD'}</div>
                <span class="hand-badge ${homeHand}">${homeHand === 'L' ? '🫲 Lefty' : homeHand === 'R' ? '🫱 Righty' : homeHand === 'S' ? '🔄 Switch' : '❓ TBD'}</span>
                <div style="font-size:11px;margin-top:4px;opacity:0.7">Pitching for ${gd.teams.home.teamName}</div>
            </div>
        </div>
        <div style="margin-top:12px;font-size:12px;opacity:0.7;">
            💡 Select players you think will crack the lineup based on the pitching matchup
        </div>
    `;
    
    // Render rosters
    const awayBatters = filterBatters(awayRoster);
    const homeBatters = filterBatters(homeRoster);
    
    // Determine platoon candidates based on opposing pitcher hand
    // Away team faces HOME pitcher, Home team faces AWAY pitcher
    const awayFacing = homeHand; // away batters face home pitcher
    const homeFacing = awayHand; // home batters face away pitcher
    
    renderRosterPanel('away', gd.teams.away, awayBatters, awayFacing, awayLineup, hasLineup);
    renderRosterPanel('home', gd.teams.home, homeBatters, homeFacing, homeLineup, hasLineup);
    
    // Show submit or results
    if (!hasLineup) {
        document.getElementById('submit-area').style.display = 'block';
        document.getElementById('results-area').style.display = 'none';
        updatePickCount();
    } else {
        document.getElementById('submit-area').style.display = 'none';
        // Show results if user had saved picks
        checkResults(awayLineup, homeLineup);
    }
}

function filterBatters(roster) {
    return roster
        .filter(p => {
            const pos = p.position?.abbreviation || '';
            return pos !== 'P' && pos !== 'TWP';
        })
        .map(p => ({
            id: p.person.id,
            name: p.person.fullName,
            number: p.jerseyNumber,
            position: p.position?.abbreviation || '??',
            bats: p.person.batSide?.code || '?',
            status: p.status?.description || 'Active',
        }))
        .sort((a, b) => {
            // Sort: OF/IF first, then by position
            const posOrder = { 'C': 1, '1B': 2, '2B': 3, '3B': 4, 'SS': 5, 'LF': 6, 'CF': 7, 'RF': 8, 'OF': 9, 'DH': 10, 'IF': 11, 'UT': 12 };
            return (posOrder[a.position] || 20) - (posOrder[b.position] || 20);
        });
}

function renderRosterPanel(side, team, batters, facingHand, lineup, hasLineup) {
    const headerEl = document.getElementById(`${side}-header`);
    const rosterEl = document.getElementById(`${side}-roster`);
    
    headerEl.innerHTML = `
        <img class="team-logo" src="${LOGO_URL(team.id)}" style="width:28px;height:28px;" onerror="this.style.display='none'">
        <span>${team.teamName}</span>
        <span style="font-size:11px;color:var(--text-light);margin-left:auto;">
            Facing ${facingHand === 'L' ? '🫲 LHP' : facingHand === 'R' ? '🫱 RHP' : '❓ TBD'}
        </span>
    `;
    
    rosterEl.innerHTML = batters.map(p => {
        const isPlatoon = isPlatoonCandidate(p.bats, facingHand);
        const inLineup = lineup.includes(p.id);
        const isSelected = picks[side].has(p.id);
        
        let rowClass = 'player-row';
        if (hasLineup && isSelected && inLineup) rowClass += ' confirmed';
        else if (hasLineup && isSelected && !inLineup) rowClass += ' missed';
        else if (isSelected) rowClass += ' selected';
        if (isPlatoon) rowClass += ' platoon-candidate';
        
        return `
        <div class="${rowClass}" onclick="togglePick('${side}', ${p.id})" data-player-id="${p.id}">
            <div class="player-checkbox">${isSelected ? '✓' : ''}</div>
            <div class="player-info">
                <div class="player-name">${p.name}</div>
                <div class="player-meta">
                    <span class="player-pos">${p.position}</span>
                    <span class="player-bats ${p.bats}">Bats ${p.bats}</span>
                    ${p.number ? `<span>#${p.number}</span>` : ''}
                    ${isPlatoon ? '<span class="platoon-tag">🏝️ Platoon?</span>' : ''}
                </div>
            </div>
        </div>`;
    }).join('');
}

function isPlatoonCandidate(bats, facingHand) {
    // A platoon candidate bats from the side that has the advantage
    // L batters vs R pitchers = advantage (so L batter is platoon candidate vs RHP)
    // R batters vs L pitchers = advantage (so R batter is platoon candidate vs LHP)
    if (facingHand === 'R' && bats === 'L') return true;
    if (facingHand === 'L' && bats === 'R') return true;
    // Switch hitters are never platoon candidates
    return false;
}

function togglePick(side, playerId) {
    if (picks[side].has(playerId)) {
        picks[side].delete(playerId);
    } else {
        picks[side].add(playerId);
    }
    
    // Update the row visually
    const row = document.querySelector(`#${side}-roster .player-row[data-player-id="${playerId}"]`);
    if (row) {
        row.classList.toggle('selected');
        const checkbox = row.querySelector('.player-checkbox');
        checkbox.textContent = picks[side].has(playerId) ? '✓' : '';
    }
    
    updatePickCount();
    savePicks();
}

function updatePickCount() {
    const total = picks.away.size + picks.home.size;
    const el = document.getElementById('pick-count');
    if (total === 0) {
        el.textContent = 'Tap players to add them to your lineup picks';
    } else {
        el.textContent = `${total} player${total !== 1 ? 's' : ''} selected`;
    }
}

// ===== SAVE / LOAD PICKS =====
function savePicks() {
    if (!currentGame) return;
    const gamePk = currentGame.gameData.game.pk;
    const data = {
        away: [...picks.away],
        home: [...picks.home],
        timestamp: new Date().toISOString()
    };
    localStorage.setItem(`platoon_${gamePk}`, JSON.stringify(data));
}

function loadSavedPicks(gamePk) {
    const saved = localStorage.getItem(`platoon_${gamePk}`);
    if (saved) {
        const data = JSON.parse(saved);
        picks.away = new Set(data.away);
        picks.home = new Set(data.home);
    }
}

function submitPicks() {
    if (picks.away.size + picks.home.size === 0) {
        alert('Pick at least one player before locking in! 🏝️');
        return;
    }
    savePicks();
    
    const btn = document.querySelector('.submit-btn');
    btn.textContent = '✅ Picks Locked!';
    btn.style.background = 'linear-gradient(135deg, #22c55e, #166534)';
    
    setTimeout(() => {
        btn.textContent = '🏝️ Lock In My Picks';
        btn.style.background = '';
    }, 2000);
}

function checkResults(awayLineup, homeLineup) {
    if (!currentGame) return;
    const gamePk = currentGame.gameData.game.pk;
    loadSavedPicks(gamePk);
    
    if (picks.away.size + picks.home.size === 0) return;
    
    let correct = 0;
    let total = picks.away.size + picks.home.size;
    
    picks.away.forEach(id => { if (awayLineup.includes(id)) correct++; });
    picks.home.forEach(id => { if (homeLineup.includes(id)) correct++; });
    
    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
    
    const resultsEl = document.getElementById('results-area');
    resultsEl.style.display = 'block';
    resultsEl.innerHTML = `
        <div class="results-card">
            <div style="font-size:14px;color:var(--text-light);margin-bottom:8px;">Your Platoon Score</div>
            <div class="results-score">${correct}/${total}</div>
            <div class="results-label">${pct}% accuracy ${pct >= 80 ? '🏆' : pct >= 60 ? '🌊' : pct >= 40 ? '🥥' : '🦀'}</div>
            <div style="margin-top:12px;font-size:13px;color:var(--text-light);">
                ${pct >= 80 ? 'Lagoon Legend! You nailed the platoons.' :
                  pct >= 60 ? 'Solid read on the matchups!' :
                  pct >= 40 ? 'Not bad — the tides were tricky today.' :
                  'Washed ashore. Better luck next game! 🏖️'}
            </div>
        </div>
    `;
}

// ===== VIEW MANAGEMENT =====
function showView(view) {
    document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
    document.getElementById(`${view}-view`).style.display = 'block';
}

function showGames() {
    showView('games');
    currentGame = null;
}

function showLoading(show) {
    document.getElementById('loading').style.display = show ? 'block' : 'none';
}
