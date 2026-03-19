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

// ===== LOAD GAME & ANALYSIS =====
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
        
        const awayLineup = feed.liveData?.boxscore?.teams?.away?.battingOrder || [];
        const homeLineup = feed.liveData?.boxscore?.teams?.home?.battingOrder || [];
        
        const awayStarterId = gd.probablePitchers?.away?.id;
        const homeStarterId = gd.probablePitchers?.home?.id;
        
        // Fetch rosters, bench players, and bullpens in parallel
        const [awayPlayers, homePlayers, awayBullpen, homeBullpen] = await Promise.all([
            fetchBenchPlayers(awayId, awayLineup),
            fetchBenchPlayers(homeId, homeLineup),
            fetchBullpen(awayId, awayStarterId),
            fetchBullpen(homeId, homeStarterId)
        ]);
        
        renderGameDetail(gd, awayPlayers, homePlayers, awayBullpen, homeBullpen, awayLineup, homeLineup);
    } catch (err) {
        console.error('Failed to load game:', err);
    }
    
    showLoading(false);
    showView('game');
}

// ===== BULLPEN DATA =====
async function fetchBullpen(teamId, starterId) {
    const rosterResp = await fetch(`${MLB_API}/teams/${teamId}/roster?rosterType=active`);
    const rosterData = await rosterResp.json();
    const roster = rosterData.roster || [];
    
    // Filter to pitchers only, exclude the starter
    const pitchers = roster.filter(p => 
        p.position?.abbreviation === 'P' && p.person.id !== starterId
    );
    
    // Fetch stats for each pitcher
    const statsPromises = pitchers.map(p =>
        fetch(`${MLB_API}/people/${p.person.id}?hydrate=stats(group=[pitching],type=[season,career],season=2025)`)
            .then(r => r.json())
            .catch(() => null)
    );
    
    const statsResults = await Promise.all(statsPromises);
    
    return pitchers.map((p, i) => {
        const personData = statsResults[i]?.people?.[0] || {};
        const seasonStats = extractPitchingStats(personData, 'season');
        const careerStats = extractPitchingStats(personData, 'career');
        const stats = seasonStats || careerStats || {};
        
        const bullpenMetrics = calcBullpenMetrics(stats, careerStats || {});
        
        return {
            id: p.person.id,
            name: personData.fullName || p.person.fullName,
            number: p.jerseyNumber,
            throws: personData.pitchHand?.code || '?',
            stats: stats,
            careerStats: careerStats || {},
            ...bullpenMetrics
        };
    }).sort((a, b) => b.entryPct - a.entryPct);
}

function extractPitchingStats(personData, type) {
    for (const s of personData.stats || []) {
        if (s.type?.displayName === type && s.group?.displayName === 'pitching' && s.splits?.length > 0) {
            return s.splits[0].stat;
        }
    }
    return null;
}

function calcBullpenMetrics(seasonStats, careerStats) {
    const s = seasonStats || {};
    const c = careerStats || {};
    
    const gp = s.gamesPlayed || c.gamesPlayed || 0;
    const gs = s.gamesStarted || c.gamesStarted || 0;
    const saves = s.saves || 0;
    const holds = s.holds || 0;
    const era = parseFloat(s.era) || parseFloat(c.era) || 4.50;
    const ip = parseFloat(s.inningsPitched) || 0;
    const whip = parseFloat(s.whip) || parseFloat(c.whip) || 1.30;
    const so = s.strikeOuts || 0;
    const bb = s.baseOnBalls || 0;
    
    // Relief appearances ratio
    const reliefGames = gp - gs;
    
    // Determine role
    let role = 'MR'; // Middle Relief
    let entryPct = 40;
    
    if (saves >= 5 || (c.saves || 0) >= 15) {
        role = 'CL'; // Closer
        entryPct = 65; // Closers pitch ~60-70% of games
    } else if (holds >= 5 || (c.holds || 0) >= 10) {
        role = 'SU'; // Setup
        entryPct = 60;
    } else if (reliefGames >= 30) {
        role = 'MR';
        // Scale by games played — workhorses pitch more
        entryPct = Math.min(70, Math.max(30, Math.round(reliefGames / 162 * 100 * 1.2)));
    } else if (reliefGames >= 15) {
        entryPct = Math.min(55, Math.max(25, Math.round(reliefGames / 162 * 100 * 1.3)));
    } else if (gp > 0) {
        entryPct = Math.min(40, Math.max(15, Math.round(reliefGames / 162 * 100 * 1.5)));
    } else {
        entryPct = 15;
    }
    
    // K rate per 9
    const k9 = ip > 0 ? (so / ip * 9).toFixed(1) : '0.0';
    const bb9 = ip > 0 ? (bb / ip * 9).toFixed(1) : '0.0';
    
    return {
        role,
        entryPct,
        era: era.toFixed(2),
        whip: whip.toFixed(2),
        k9,
        bb9,
        ip: ip.toFixed(1),
        saves,
        holds,
        gamesPlayed: gp,
        reliefGames
    };
}

// ===== BENCH PLAYER DATA =====
async function fetchBenchPlayers(teamId, lineup) {
    const rosterResp = await fetch(`${MLB_API}/teams/${teamId}/roster?rosterType=active`);
    const rosterData = await rosterResp.json();
    const roster = rosterData.roster || [];
    
    const batters = roster.filter(p => p.position?.abbreviation !== 'P' && p.position?.abbreviation !== 'TWP');
    
    const statsPromises = batters.map(p => 
        fetch(`${MLB_API}/people/${p.person.id}?hydrate=stats(group=[hitting],type=[season,career],season=2025)`)
            .then(r => r.json())
            .catch(() => null)
    );
    
    const statsResults = await Promise.all(statsPromises);
    
    return batters.map((p, i) => {
        const personData = statsResults[i]?.people?.[0] || {};
        const seasonStats = extractHittingStats(personData, 'season');
        const careerStats = extractHittingStats(personData, 'career');
        const stats = seasonStats || careerStats || {};
        const benchMetrics = calcBenchMetrics(stats, careerStats || {}, lineup.includes(p.person.id));
        
        return {
            id: p.person.id,
            name: personData.fullName || p.person.fullName,
            number: p.jerseyNumber,
            position: p.position?.abbreviation || '??',
            bats: personData.batSide?.code || '?',
            isStarter: lineup.includes(p.person.id),
            stats,
            careerStats: careerStats || {},
            ...benchMetrics
        };
    });
}

function extractHittingStats(personData, type) {
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
    
    const gp = s.gamesPlayed || c.gamesPlayed || 0;
    const ab = s.atBats || 0;
    const pa = s.plateAppearances || 0;
    const hr = s.homeRuns || 0;
    const careerHR = c.homeRuns || 0;
    const careerPA = c.plateAppearances || 0;
    
    const abPerGame = gp > 0 ? ab / gp : 0;
    const isBenchProfile = abPerGame < 3.0 && abPerGame > 0;
    
    let entryPct;
    if (isStarter) {
        entryPct = 0;
    } else if (gp === 0) {
        entryPct = 15;
    } else if (isBenchProfile) {
        entryPct = Math.min(85, Math.max(20, Math.round(abPerGame * 30 + 10)));
    } else {
        entryPct = Math.min(75, Math.max(25, Math.round(40 + abPerGame * 5)));
    }
    
    let hrRate;
    if (pa >= 100) {
        hrRate = hr / pa;
    } else if (careerPA >= 200) {
        const seasonRate = pa > 0 ? hr / pa : 0;
        const careerRate = careerHR / careerPA;
        const weight = Math.min(pa / 100, 1);
        hrRate = seasonRate * weight + careerRate * (1 - weight);
    } else if (pa > 0) {
        hrRate = hr / pa;
    } else if (careerPA > 0) {
        hrRate = careerHR / careerPA;
    } else {
        hrRate = 0.02;
    }
    
    const hrPerEntry = 1 - Math.pow(1 - hrRate, 1.5);
    const hrPct = Math.round(hrPerEntry * 1000) / 10;
    
    const bombScore = (entryPct / 100) * hrPerEntry;
    const bombPct = Math.round(bombScore * 1000) / 10;
    
    return {
        entryPct: isStarter ? null : entryPct,
        hrPct: Math.max(0.1, hrPct),
        bombPct: isStarter ? null : Math.max(0.1, bombPct),
        hrRate,
        abPerGame,
        isBenchProfile
    };
}

// ===== RENDER GAME =====
function renderGameDetail(gd, awayPlayers, homePlayers, awayBullpen, homeBullpen, awayLineup, homeLineup) {
    const hasLineup = awayLineup.length > 0;
    const awayPitcher = gd.probablePitchers?.away;
    const homePitcher = gd.probablePitchers?.home;
    
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
    
    document.getElementById('matchup-info').innerHTML = `
        <h3>💣 Bench Bomb Watch</h3>
        <p style="margin-top:6px;font-size:13px;opacity:0.85;">Which bench bats will enter and go yard? Scout the opposing bullpen to find the matchup edge.</p>
        <div style="display:flex;justify-content:center;gap:20px;margin-top:12px;font-size:11px;opacity:0.7;flex-wrap:wrap;">
            <span>📊 Entry% = likelihood to enter</span>
            <span>💣 HR% = HR odds per entry</span>
            <span>🏝️ Bomb = combined score</span>
        </div>
    `;
    
    // Away side: away bench + HOME bullpen (they face home pitchers)
    renderTeamPanel('away', gd.teams.away, gd.teams.home, awayPlayers, homeBullpen, homePitcher, hasLineup);
    // Home side: home bench + AWAY bullpen (they face away pitchers)
    renderTeamPanel('home', gd.teams.home, gd.teams.away, homePlayers, awayBullpen, awayPitcher, hasLineup);
    
    if (!hasLineup) {
        document.getElementById('submit-area').style.display = 'block';
        document.getElementById('results-area').style.display = 'none';
        updatePickCount();
    } else {
        document.getElementById('submit-area').style.display = 'none';
    }
}

function renderTeamPanel(side, battingTeam, pitchingTeam, players, bullpen, starter, hasLineup) {
    const headerEl = document.getElementById(`${side}-header`);
    const rosterEl = document.getElementById(`${side}-roster`);
    
    const starters = players.filter(p => p.isStarter);
    const bench = players.filter(p => !p.isStarter);
    bench.sort((a, b) => (b.bombPct || 0) - (a.bombPct || 0));
    
    headerEl.innerHTML = `
        <img class="team-logo" src="${LOGO_URL(battingTeam.id)}" style="width:28px;height:28px;" onerror="this.style.display='none'">
        <span>${battingTeam.teamName}</span>
        <span style="font-size:11px;color:var(--text-light);margin-left:auto;">
            ${bench.length} on bench
        </span>
    `;
    
    let html = '';
    
    // === OPPOSING BULLPEN SECTION ===
    html += `
        <div class="bullpen-section">
            <div class="section-label bullpen-label">
                <img class="team-logo" src="${LOGO_URL(pitchingTeam.id)}" style="width:18px;height:18px;vertical-align:middle;" onerror="this.style.display='none'">
                ${pitchingTeam.teamName} Bullpen
            </div>
            ${starter ? `
                <div class="starter-pitcher-row">
                    <span class="sp-badge">SP</span>
                    <span class="sp-name">${starter.fullName || 'TBD'}</span>
                    <span class="pitcher-hand ${starter.pitchHand?.code || ''}">${starter.pitchHand?.code || '?'}HP</span>
                </div>
            ` : ''}
            <div class="bullpen-grid">
                ${bullpen.length > 0 ? bullpen.map(p => renderBullpenCard(p)).join('') : '<div style="padding:8px 10px;font-size:12px;color:var(--text-light);">Bullpen data not available</div>'}
            </div>
        </div>
    `;
    
    // === BENCH SECTION ===
    if (hasLineup && starters.length > 0) {
        html += `<div class="section-label">💣 Bench — Bomb Candidates</div>`;
    } else {
        html += `<div class="section-label">💣 Bench Bomb Rankings</div>`;
        if (!hasLineup) {
            html += `<div style="font-size:11px;color:var(--text-light);padding:0 10px 8px;">Lineups not posted yet — full roster ranked by bomb potential</div>`;
        }
    }
    
    if (bench.length === 0 && !hasLineup) {
        const allRanked = [...players].sort((a, b) => (b.hrPct || 0) - (a.hrPct || 0));
        html += allRanked.map((p, i) => renderBenchRow(p, side, i + 1, false)).join('');
    } else {
        html += bench.map((p, i) => renderBenchRow(p, side, i + 1, true)).join('');
    }
    
    if (hasLineup && starters.length > 0) {
        html += `<div class="section-label" style="margin-top:8px;opacity:0.5;">Starting Lineup</div>`;
        html += starters.map(p => renderStarterRow(p)).join('');
    }
    
    rosterEl.innerHTML = html;
}

function renderBullpenCard(p) {
    const handClass = p.throws === 'L' ? 'lefty' : p.throws === 'R' ? 'righty' : 'switch';
    const entryLevel = p.entryPct >= 55 ? 'high' : p.entryPct >= 35 ? 'mid' : 'low';
    
    const roleBadge = {
        'CL': { label: 'CLOSER', class: 'role-closer' },
        'SU': { label: 'SETUP', class: 'role-setup' },
        'MR': { label: 'MIDDLE', class: 'role-middle' }
    }[p.role] || { label: 'RP', class: 'role-middle' };
    
    return `
    <div class="bullpen-card ${handClass}-card">
        <div class="bp-top">
            <span class="bp-role ${roleBadge.class}">${roleBadge.label}</span>
            <span class="bp-entry bp-entry-${entryLevel}">${p.entryPct}%</span>
        </div>
        <div class="bp-name">${p.name}</div>
        <div class="bp-meta">
            <span class="pitcher-hand ${p.throws}">${p.throws}HP</span>
            ${p.number ? `<span>#${p.number}</span>` : ''}
        </div>
        <div class="bp-stats">
            <span title="ERA">${p.era} ERA</span>
            <span title="WHIP">${p.whip} W</span>
            <span title="K/9">${p.k9} K</span>
        </div>
        ${p.saves > 0 ? `<div class="bp-saves">${p.saves} SV</div>` : ''}
        ${p.holds > 0 ? `<div class="bp-saves">${p.holds} HLD</div>` : ''}
    </div>`;
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
            <span class="stat-pill hr-pill"><span class="pill-label">HR</span><span class="pill-value">${p.stats?.homeRuns || 0}</span></span>
        </div>
    </div>`;
}

function renderBenchRow(p, side, rank, showEntry) {
    const isSelected = picks[side].has(p.id);
    const bombLevel = p.bombPct >= 3 ? 'hot' : p.bombPct >= 1.5 ? 'warm' : 'cold';
    
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
            ${showEntry ? `<div class="stat-pill entry-pill"><span class="pill-label">Entry</span><span class="pill-value">${p.entryPct}%</span></div>` : ''}
            <div class="stat-pill hr-pill"><span class="pill-label">HR</span><span class="pill-value">${p.hrPct}%</span></div>
            ${showEntry ? `<div class="stat-pill bomb-pill ${bombLevel}-pill"><span class="pill-label">💣</span><span class="pill-value">${p.bombPct}%</span></div>` : ''}
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
    document.getElementById('pick-count').textContent = total === 0 
        ? 'Tap bench players you think will enter and hit a HR 💣' 
        : `${total} bench bomb${total !== 1 ? 's' : ''} selected`;
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
    localStorage.setItem(`platoon_${currentGame.gameData.game.pk}`, JSON.stringify({
        away: [...picks.away], home: [...picks.home], timestamp: new Date().toISOString()
    }));
}

// ===== VIEW MANAGEMENT =====
function showView(view) {
    document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
    document.getElementById(`${view}-view`).style.display = 'block';
}
function showGames() { showView('games'); currentGame = null; }
function showLoading(show) { document.getElementById('loading').style.display = show ? 'block' : 'none'; }
