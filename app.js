// ===== THE PLATOON LAGOON — BENCH BOMBS 💣 =====

const MLB_API = 'https://statsapi.mlb.com/api/v1';
const LOGO_URL = (id) => `https://www.mlbstatic.com/team-logos/${id}.svg`;

let currentDate = new Date();
let currentGame = null;
let picks = { away: new Set(), home: new Set() };

// ===== DATE HELPERS =====
function formatDate(d) {
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function apiDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function gameTime(iso) {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
    currentDate = new Date();
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
        const resp = await fetch(`${MLB_API}/schedule?date=${apiDate(currentDate)}&sportId=1&hydrate=probablePitcher(note),team,linescore`);
        const data = await resp.json();
        renderGames(data.dates?.[0]?.games || []);
    } catch (err) {
        console.error('Failed to load games:', err);
        document.getElementById('games-grid').innerHTML = '<p style="text-align:center;padding:40px;color:#64748b;">🌊 Couldn\'t reach the MLB API.</p>';
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
        const state = g.status.abstractGameState;
        let statusClass = 'preview';
        let statusText = gameTime(g.gameDate);
        if (state === 'Live') { statusClass = 'live'; statusText = g.linescore ? `${g.linescore.currentInningOrdinal || ''} ${g.linescore.inningHalf || ''}` : 'LIVE'; }
        if (state === 'Final') { statusClass = 'final'; statusText = 'FINAL'; }
        
        return `
        <div class="game-card" onclick="loadGame(${g.gamePk})">
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <span class="game-status ${statusClass}">${statusText}</span>
                <span style="font-size:11px;color:var(--text-light);">${g.gameType === 'S' ? 'Spring Training' : g.gameType === 'R' ? '' : g.gameType}</span>
            </div>
            <div class="game-card-teams" style="margin-top:10px;">
                <div class="game-card-team">
                    <img class="team-logo" src="${LOGO_URL(away.team.id)}" alt="" onerror="this.style.display='none'">
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
                    <img class="team-logo" src="${LOGO_URL(home.team.id)}" alt="" onerror="this.style.display='none'">
                </div>
            </div>
        </div>`;
    }).join('');
}

// ===== LOAD GAME & BENCH ANALYSIS =====
async function loadGame(gamePk) {
    showLoading(true);
    picks = { away: new Set(), home: new Set() };
    
    try {
        const feedResp = await fetch(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`);
        const feed = await feedResp.json();
        currentGame = feed;
        
        const gd = feed.gameData;
        const awayId = gd.teams.away.id;
        const homeId = gd.teams.home.id;
        
        // Get lineups if game started
        const awayLineup = feed.liveData?.boxscore?.teams?.away?.battingOrder || [];
        const homeLineup = feed.liveData?.boxscore?.teams?.home?.battingOrder || [];
        
        // Get active rosters with 2025 stats
        const [awayPlayers, homePlayers] = await Promise.all([
            fetchBenchPlayers(awayId, awayLineup),
            fetchBenchPlayers(homeId, homeLineup)
        ]);
        
        renderGameDetail(gd, awayPlayers, homePlayers, awayLineup, homeLineup);
    } catch (err) {
        console.error('Failed to load game:', err);
    }
    
    showLoading(false);
    showView('game');
}

async function fetchBenchPlayers(teamId, lineup) {
    // Get roster
    const rosterResp = await fetch(`${MLB_API}/teams/${teamId}/roster?rosterType=active`);
    const rosterData = await rosterResp.json();
    const roster = rosterData.roster || [];
    
    // Filter to position players only
    const batters = roster.filter(p => p.position?.abbreviation !== 'P' && p.position?.abbreviation !== 'TWP');
    
    // Fetch stats for each batter (2025 season + career)
    const playerIds = batters.map(p => p.person.id);
    const statsPromises = playerIds.map(id => 
        fetch(`${MLB_API}/people/${id}?hydrate=stats(group=[hitting],type=[season,career],season=2025)`)
            .then(r => r.json())
            .catch(() => null)
    );
    
    const statsResults = await Promise.all(statsPromises);
    
    return batters.map((p, i) => {
        const personData = statsResults[i]?.people?.[0] || {};
        const seasonStats = extractStats(personData, 'season');
        const careerStats = extractStats(personData, 'career');
        
        // Use 2025 season stats primarily, fall back to career
        const stats = seasonStats || careerStats || {};
        
        const gamesPlayed = stats.gamesPlayed || 0;
        const atBats = stats.atBats || 0;
        const homeRuns = stats.homeRuns || 0;
        const plateAppearances = stats.plateAppearances || 0;
        
        // Calculate bench metrics
        const benchMetrics = calcBenchMetrics(stats, careerStats || {}, lineup.includes(p.person.id));
        
        return {
            id: p.person.id,
            name: personData.fullName || p.person.fullName,
            number: p.jerseyNumber,
            position: p.position?.abbreviation || '??',
            bats: personData.batSide?.code || '?',
            isStarter: lineup.includes(p.person.id),
            stats: stats,
            careerStats: careerStats || {},
            ...benchMetrics
        };
    });
}

function extractStats(personData, type) {
    for (const s of personData.stats || []) {
        if (s.type?.displayName === type && s.group?.displayName === 'hitting' && s.splits?.length > 0) {
            return s.splits[0].stat;
        }
    }
    return null;
}

function calcBenchMetrics(seasonStats, careerStats, isStarter) {
    const s = seasonStats || {};
    const c = careerStats || {};
    
    // === ENTRY ODDS ===
    // Based on games played vs a full season benchmark
    // Bench players typically appear in 50-70% of games
    // Use GP and context clues
    const gp = s.gamesPlayed || c.gamesPlayed || 0;
    const ab = s.atBats || 0;
    const pa = s.plateAppearances || 0;
    
    // AB per game — starters average ~3.5-4.0 AB/G, bench ~1.0-2.0
    const abPerGame = gp > 0 ? ab / gp : 0;
    const isBenchProfile = abPerGame < 3.0 && abPerGame > 0;
    
    // Entry likelihood for bench players (how often they get in games)
    // Higher AB/G among bench = more likely to enter
    let entryPct;
    if (isStarter) {
        entryPct = 0; // Already starting
    } else if (gp === 0) {
        entryPct = 15; // Unknown — low default
    } else if (isBenchProfile) {
        // Bench player — scale by AB/G relative to team games
        entryPct = Math.min(85, Math.max(20, Math.round(abPerGame * 30 + 10)));
    } else {
        // Regular who's on the bench today — likely to PH
        entryPct = Math.min(75, Math.max(25, Math.round(40 + abPerGame * 5)));
    }
    
    // === HR ODDS (per plate appearance) ===
    const hr = s.homeRuns || 0;
    const careerHR = c.homeRuns || 0;
    const careerPA = c.plateAppearances || 0;
    
    // HR rate — use season if enough sample, else blend with career
    let hrRate;
    if (pa >= 100) {
        hrRate = hr / pa;
    } else if (careerPA >= 200) {
        // Blend season and career
        const seasonRate = pa > 0 ? hr / pa : 0;
        const careerRate = careerHR / careerPA;
        const weight = Math.min(pa / 100, 1);
        hrRate = seasonRate * weight + careerRate * (1 - weight);
    } else if (pa > 0) {
        hrRate = hr / pa;
    } else if (careerPA > 0) {
        hrRate = careerHR / careerPA;
    } else {
        hrRate = 0.02; // League average ~3%
    }
    
    // Bench HR boost — pinch hitters swing for the fences
    // Historical PH HR rate is actually lower, but they get favorable counts more
    const benchHRRate = hrRate;
    
    // HR% per appearance (assuming ~1.5 PA if they enter)
    const hrPerEntry = 1 - Math.pow(1 - benchHRRate, 1.5);
    const hrPct = Math.round(hrPerEntry * 1000) / 10;
    
    // === BENCH BOMB SCORE ===
    // Combined: probability they enter AND hit a HR
    const bombScore = (entryPct / 100) * hrPerEntry;
    const bombPct = Math.round(bombScore * 1000) / 10;
    
    return {
        entryPct: isStarter ? null : entryPct,
        hrPct: Math.max(0.1, hrPct),
        bombPct: isStarter ? null : Math.max(0.1, bombPct),
        hrRate: hrRate,
        abPerGame: abPerGame,
        isBenchProfile: isBenchProfile
    };
}

function renderGameDetail(gd, awayPlayers, homePlayers, awayLineup, homeLineup) {
    const hasLineup = awayLineup.length > 0;
    
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
    
    // Info
    document.getElementById('matchup-info').innerHTML = `
        <h3>💣 Bench Bomb Watch</h3>
        <p style="margin-top:6px;font-size:13px;opacity:0.85;">Which bench bats will enter the game and go yard?</p>
        <div style="display:flex;justify-content:center;gap:24px;margin-top:12px;font-size:11px;opacity:0.7;">
            <span>📊 Entry% = likelihood to enter game</span>
            <span>💣 HR% = chance of HR if they enter</span>
            <span>🏝️ Bomb = Entry × HR combined</span>
        </div>
    `;
    
    // Render team panels
    renderTeamPanel('away', gd.teams.away, awayPlayers, hasLineup);
    renderTeamPanel('home', gd.teams.home, homePlayers, hasLineup);
    
    // Submit area
    if (!hasLineup) {
        document.getElementById('submit-area').style.display = 'block';
        document.getElementById('results-area').style.display = 'none';
        updatePickCount();
    } else {
        document.getElementById('submit-area').style.display = 'none';
    }
}

function renderTeamPanel(side, team, players, hasLineup) {
    const headerEl = document.getElementById(`${side}-header`);
    const rosterEl = document.getElementById(`${side}-roster`);
    
    // Split into starters and bench
    const starters = players.filter(p => p.isStarter);
    const bench = players.filter(p => !p.isStarter);
    
    // Sort bench by bomb score descending
    bench.sort((a, b) => (b.bombPct || 0) - (a.bombPct || 0));
    
    headerEl.innerHTML = `
        <img class="team-logo" src="${LOGO_URL(team.id)}" style="width:28px;height:28px;" onerror="this.style.display='none'">
        <span>${team.teamName}</span>
        <span style="font-size:11px;color:var(--text-light);margin-left:auto;">
            ${bench.length} on bench
        </span>
    `;
    
    let html = '';
    
    if (hasLineup && starters.length > 0) {
        html += `<div class="section-label">Starting Lineup</div>`;
        html += starters.map(p => renderStarterRow(p)).join('');
        html += `<div class="section-label" style="margin-top:12px;">🏝️ The Bench — Bomb Candidates</div>`;
    } else {
        html += `<div class="section-label">🏝️ Bench Bomb Rankings</div>`;
        html += `<div style="font-size:11px;color:var(--text-light);padding:0 10px 8px;">Lineups not yet posted — showing full roster ranked by bomb potential</div>`;
    }
    
    if (bench.length === 0 && !hasLineup) {
        // No lineup yet — show all players ranked
        const allRanked = [...players].sort((a, b) => (b.hrPct || 0) - (a.hrPct || 0));
        html = `<div class="section-label">🏝️ Roster — Bomb Potential Rankings</div>`;
        html += allRanked.map((p, i) => renderBenchRow(p, side, i + 1, false)).join('');
    } else {
        html += bench.map((p, i) => renderBenchRow(p, side, i + 1, true)).join('');
    }
    
    rosterEl.innerHTML = html;
}

function renderStarterRow(p) {
    return `
    <div class="player-row starter-row">
        <div class="rank-badge starter-badge">✓</div>
        <div class="player-info">
            <div class="player-name">${p.name}</div>
            <div class="player-meta">
                <span class="player-pos">${p.position}</span>
                <span class="player-bats ${p.bats}">Bats ${p.bats}</span>
                ${p.number ? `<span>#${p.number}</span>` : ''}
            </div>
        </div>
        <div class="stat-pills">
            <span class="stat-pill hr-pill" title="HR Rate">${p.stats?.homeRuns || 0} HR</span>
        </div>
    </div>`;
}

function renderBenchRow(p, side, rank, showEntry) {
    const isSelected = picks[side].has(p.id);
    const bombLevel = p.bombPct >= 3 ? 'hot' : p.bombPct >= 1.5 ? 'warm' : 'cold';
    const hrLevel = p.hrPct >= 5 ? 'hot' : p.hrPct >= 3 ? 'warm' : 'cold';
    
    return `
    <div class="player-row bench-row ${isSelected ? 'selected' : ''} ${bombLevel}-bomb" 
         onclick="togglePick('${side}', ${p.id})" data-player-id="${p.id}">
        <div class="rank-badge rank-${bombLevel}">${rank}</div>
        <div class="player-info">
            <div class="player-name">${p.name}</div>
            <div class="player-meta">
                <span class="player-pos">${p.position}</span>
                <span class="player-bats ${p.bats}">Bats ${p.bats}</span>
                ${p.number ? `<span>#${p.number}</span>` : ''}
                ${p.stats ? `<span>${p.stats.homeRuns || 0} HR / ${p.stats.atBats || 0} AB</span>` : ''}
            </div>
        </div>
        <div class="stat-pills">
            ${showEntry ? `<div class="stat-pill entry-pill" title="Entry Likelihood"><span class="pill-label">Entry</span><span class="pill-value">${p.entryPct}%</span></div>` : ''}
            <div class="stat-pill hr-pill ${hrLevel}-pill" title="HR% if enters"><span class="pill-label">HR</span><span class="pill-value">${p.hrPct}%</span></div>
            ${showEntry ? `<div class="stat-pill bomb-pill ${bombLevel}-pill" title="Bench Bomb Score"><span class="pill-label">💣</span><span class="pill-value">${p.bombPct}%</span></div>` : ''}
        </div>
    </div>`;
}

// ===== PICKS =====
function togglePick(side, playerId) {
    if (picks[side].has(playerId)) {
        picks[side].delete(playerId);
    } else {
        picks[side].add(playerId);
    }
    
    const row = document.querySelector(`#${side}-roster .player-row[data-player-id="${playerId}"]`);
    if (row) row.classList.toggle('selected');
    
    updatePickCount();
    savePicks();
}

function updatePickCount() {
    const total = picks.away.size + picks.home.size;
    const el = document.getElementById('pick-count');
    el.textContent = total === 0 ? 'Tap bench players you think will enter and hit a HR 💣' : `${total} bench bomb${total !== 1 ? 's' : ''} selected`;
}

function submitPicks() {
    if (picks.away.size + picks.home.size === 0) {
        alert('Pick at least one bench bomber! 💣');
        return;
    }
    savePicks();
    const btn = document.querySelector('.submit-btn');
    btn.textContent = '✅ Bombs Locked!';
    btn.style.background = 'linear-gradient(135deg, #22c55e, #166534)';
    setTimeout(() => { btn.textContent = '💣 Lock In My Bombs'; btn.style.background = ''; }, 2000);
}

function savePicks() {
    if (!currentGame) return;
    const gamePk = currentGame.gameData.game.pk;
    localStorage.setItem(`platoon_${gamePk}`, JSON.stringify({
        away: [...picks.away], home: [...picks.home], timestamp: new Date().toISOString()
    }));
}

// ===== VIEW MANAGEMENT =====
function showView(view) {
    document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
    document.getElementById(`${view}-view`).style.display = 'block';
}

function showGames() { showView('games'); currentGame = null; }

function showLoading(show) {
    document.getElementById('loading').style.display = show ? 'block' : 'none';
}
