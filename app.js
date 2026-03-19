// ===== THE PLATOON LAGOON — BENCH BOMBS 💣 =====

const MLB_API = 'https://statsapi.mlb.com/api/v1';
const LOGO_URL = (id) => `https://www.mlbstatic.com/team-logos/${id}.svg`;

let currentDate = new Date();
let currentGame = null;

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

// ===== LOAD GAME =====
async function loadGame(gamePk) {
    showLoading(true);
    
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

// ===== BULLPEN =====
async function fetchBullpen(teamId, starterId) {
    const rosterResp = await fetch(`${MLB_API}/teams/${teamId}/roster?rosterType=active`);
    const rosterData = await rosterResp.json();
    const roster = rosterData.roster || [];
    
    const pitchers = roster.filter(p => p.position?.abbreviation === 'P' && p.person.id !== starterId);
    
    const statsResults = await Promise.all(
        pitchers.map(p =>
            fetch(`${MLB_API}/people/${p.person.id}?hydrate=stats(group=[pitching],type=[season,career],season=2025)`)
                .then(r => r.json()).catch(() => null)
        )
    );
    
    return pitchers.map((p, i) => {
        const pd = statsResults[i]?.people?.[0] || {};
        const ss = extractStats(pd, 'pitching', 'season');
        const cs = extractStats(pd, 'pitching', 'career');
        const s = ss || cs || {};
        
        const gp = s.gamesPlayed || 0;
        const gs = s.gamesStarted || 0;
        const saves = s.saves || 0;
        const holds = s.holds || 0;
        const era = parseFloat(s.era) || parseFloat((cs||{}).era) || 4.50;
        const ip = parseFloat(s.inningsPitched) || 0;
        const whip = parseFloat(s.whip) || parseFloat((cs||{}).whip) || 1.30;
        const so = s.strikeOuts || 0;
        const bb = s.baseOnBalls || 0;
        const relief = gp - gs;
        
        let role = 'MR', entryPct = 40;
        if (saves >= 5 || (cs||{}).saves >= 15) { role = 'CL'; entryPct = 65; }
        else if (holds >= 5 || (cs||{}).holds >= 10) { role = 'SU'; entryPct = 60; }
        else if (relief >= 30) { entryPct = Math.min(70, Math.max(30, Math.round(relief / 162 * 120))); }
        else if (relief >= 15) { entryPct = Math.min(55, Math.max(25, Math.round(relief / 162 * 130))); }
        else if (gp > 0) { entryPct = Math.min(40, Math.max(15, Math.round(relief / 162 * 150))); }
        else { entryPct = 15; }
        
        return {
            id: p.person.id, name: pd.fullName || p.person.fullName,
            number: p.jerseyNumber, throws: pd.pitchHand?.code || '?',
            role, entryPct,
            era: era.toFixed(2), whip: whip.toFixed(2),
            k9: ip > 0 ? (so / ip * 9).toFixed(1) : '0.0',
            saves, holds, gamesPlayed: gp
        };
    }).sort((a, b) => b.entryPct - a.entryPct);
}

// ===== BENCH PLAYERS =====
async function fetchBenchPlayers(teamId, lineup) {
    const rosterResp = await fetch(`${MLB_API}/teams/${teamId}/roster?rosterType=active`);
    const rosterData = await rosterResp.json();
    const batters = (rosterData.roster || []).filter(p => p.position?.abbreviation !== 'P' && p.position?.abbreviation !== 'TWP');
    
    const statsResults = await Promise.all(
        batters.map(p =>
            fetch(`${MLB_API}/people/${p.person.id}?hydrate=stats(group=[hitting],type=[season,career],season=2025)`)
                .then(r => r.json()).catch(() => null)
        )
    );
    
    return batters.map((p, i) => {
        const pd = statsResults[i]?.people?.[0] || {};
        const ss = extractStats(pd, 'hitting', 'season');
        const cs = extractStats(pd, 'hitting', 'career');
        const s = ss || cs || {};
        
        const gp = s.gamesPlayed || (cs||{}).gamesPlayed || 0;
        const ab = s.atBats || 0;
        const pa = s.plateAppearances || 0;
        const hr = s.homeRuns || 0;
        const careerHR = (cs||{}).homeRuns || 0;
        const careerPA = (cs||{}).plateAppearances || 0;
        const isStarter = lineup.includes(p.person.id);
        
        const abPerGame = gp > 0 ? ab / gp : 0;
        
        // Entry likelihood
        let entryPct = 0;
        if (!isStarter) {
            if (gp === 0) entryPct = 15;
            else if (abPerGame < 3.0) entryPct = Math.min(85, Math.max(20, Math.round(abPerGame * 30 + 10)));
            else entryPct = Math.min(75, Math.max(25, Math.round(40 + abPerGame * 5)));
        }
        
        // HR rate (blended season + career)
        let hrRate;
        if (pa >= 100) hrRate = hr / pa;
        else if (careerPA >= 200) {
            const w = Math.min(pa / 100, 1);
            hrRate = (pa > 0 ? hr/pa : 0) * w + (careerHR/careerPA) * (1-w);
        }
        else if (pa > 0) hrRate = hr / pa;
        else if (careerPA > 0) hrRate = careerHR / careerPA;
        else hrRate = 0.02;
        
        // Per-entry HR chance (~1.5 PA per entry)
        const hrPerEntry = 1 - Math.pow(1 - hrRate, 1.5);
        const hrPct = Math.round(hrPerEntry * 1000) / 10;
        
        // Bomb = entry × HR
        const bombPct = isStarter ? null : Math.max(0.1, Math.round((entryPct / 100) * hrPerEntry * 1000) / 10);
        
        return {
            id: p.person.id, name: pd.fullName || p.person.fullName,
            number: p.jerseyNumber, position: p.position?.abbreviation || '??',
            bats: pd.batSide?.code || '?', isStarter, stats: s,
            entryPct: isStarter ? null : entryPct,
            hrPct: Math.max(0.1, hrPct), bombPct
        };
    });
}

function extractStats(personData, group, type) {
    for (const s of personData.stats || []) {
        if (s.type?.displayName === type && s.group?.displayName === group && s.splits?.length > 0)
            return s.splits[0].stat;
    }
    return null;
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
        <p style="margin-top:6px;font-size:13px;opacity:0.85;">Top bench bats most likely to enter and go yard, plus the opposing bullpen they'll face.</p>
        <div class="legend">
            <span class="legend-item"><span class="legend-dot entry-dot"></span>Entry% — odds of entering game</span>
            <span class="legend-item"><span class="legend-dot hr-dot"></span>HR% — HR odds per entry</span>
            <span class="legend-item"><span class="legend-dot bomb-dot"></span>Bomb — combined score</span>
        </div>
    `;
    
    renderTeamPanel('away', gd.teams.away, gd.teams.home, awayPlayers, homeBullpen, homePitcher, hasLineup);
    renderTeamPanel('home', gd.teams.home, gd.teams.away, homePlayers, awayBullpen, awayPitcher, hasLineup);
}

function renderTeamPanel(side, battingTeam, pitchingTeam, players, bullpen, starter, hasLineup) {
    const headerEl = document.getElementById(`${side}-header`);
    const rosterEl = document.getElementById(`${side}-roster`);
    
    const bench = players.filter(p => !p.isStarter).sort((a, b) => (b.bombPct || 0) - (a.bombPct || 0));
    const topBombs = hasLineup ? bench : [...players].sort((a, b) => (b.hrPct || 0) - (a.hrPct || 0));
    
    headerEl.innerHTML = `
        <img class="team-logo" src="${LOGO_URL(battingTeam.id)}" style="width:28px;height:28px;" onerror="this.style.display='none'">
        <span>${battingTeam.teamName}</span>
    `;
    
    let html = '';
    
    // === TOP BENCH BOMBS ===
    if (topBombs.length > 0) {
        html += `<div class="section-label">💣 ${hasLineup ? 'Top Bench Bombs' : 'Bomb Potential (Lineups TBD)'}</div>`;
        
        // Show top 5 as featured cards
        const featured = topBombs.slice(0, 5);
        html += `<div class="bomb-cards">`;
        featured.forEach((p, i) => {
            const bombLevel = (p.bombPct || p.hrPct) >= 3 ? 'hot' : (p.bombPct || p.hrPct) >= 1.5 ? 'warm' : 'cold';
            html += `
            <div class="bomb-card ${bombLevel}-bomb-card">
                <div class="bomb-rank">${i + 1}</div>
                <div class="bomb-player">
                    <div class="bomb-name">${p.name}</div>
                    <div class="bomb-meta">
                        <span class="player-pos">${p.position}</span>
                        <span class="player-bats ${p.bats}">Bats ${p.bats}</span>
                        ${p.number ? `<span>#${p.number}</span>` : ''}
                    </div>
                    <div class="bomb-stats-line">
                        ${p.stats ? `${p.stats.homeRuns || 0} HR / ${p.stats.atBats || 0} AB` : ''}
                        ${p.stats?.avg ? ` · ${p.stats.avg} AVG` : ''}
                    </div>
                </div>
                <div class="bomb-scores">
                    ${p.entryPct != null ? `<div class="bomb-score-item entry-score"><div class="score-val">${p.entryPct}%</div><div class="score-label">Entry</div></div>` : ''}
                    <div class="bomb-score-item hr-score"><div class="score-val">${p.hrPct}%</div><div class="score-label">HR</div></div>
                    ${p.bombPct != null ? `<div class="bomb-score-item total-score ${bombLevel}-score"><div class="score-val">${p.bombPct}%</div><div class="score-label">💣</div></div>` : ''}
                </div>
            </div>`;
        });
        html += `</div>`;
        
        // Rest of bench as compact list
        if (topBombs.length > 5) {
            html += `<div class="section-label" style="font-size:10px;opacity:0.6;padding-top:4px;">Rest of Bench</div>`;
            topBombs.slice(5).forEach((p, i) => {
                html += `
                <div class="compact-row">
                    <span class="compact-rank">${i + 6}</span>
                    <span class="compact-name">${p.name}</span>
                    <span class="compact-pos">${p.position}</span>
                    <span class="player-bats ${p.bats}" style="font-size:9px;">${p.bats}</span>
                    ${p.entryPct != null ? `<span class="compact-stat">${p.entryPct}% in</span>` : ''}
                    <span class="compact-stat">${p.hrPct}% HR</span>
                    ${p.bombPct != null ? `<span class="compact-bomb">${p.bombPct}%💣</span>` : ''}
                </div>`;
            });
        }
    }
    
    // === OPPOSING BULLPEN ===
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
                </div>` : ''}
            <div class="bullpen-grid">
                ${bullpen.length > 0 ? bullpen.map(p => {
                    const handClass = p.throws === 'L' ? 'lefty' : 'righty';
                    const entryLevel = p.entryPct >= 55 ? 'high' : p.entryPct >= 35 ? 'mid' : 'low';
                    const roleInfo = { 'CL': { l: 'CLOSER', c: 'role-closer' }, 'SU': { l: 'SETUP', c: 'role-setup' }, 'MR': { l: 'MIDDLE', c: 'role-middle' } }[p.role] || { l: 'RP', c: 'role-middle' };
                    return `
                    <div class="bullpen-card ${handClass}-card">
                        <div class="bp-top">
                            <span class="bp-role ${roleInfo.c}">${roleInfo.l}</span>
                            <span class="bp-entry bp-entry-${entryLevel}">${p.entryPct}%</span>
                        </div>
                        <div class="bp-name">${p.name}</div>
                        <div class="bp-meta">
                            <span class="pitcher-hand ${p.throws}">${p.throws}HP</span>
                            ${p.number ? `<span>#${p.number}</span>` : ''}
                        </div>
                        <div class="bp-stats">
                            <span>${p.era} ERA</span>
                            <span>${p.whip} W</span>
                            <span>${p.k9} K/9</span>
                        </div>
                        ${p.saves > 0 ? `<div class="bp-extra">${p.saves} SV</div>` : ''}
                        ${p.holds > 0 ? `<div class="bp-extra">${p.holds} HLD</div>` : ''}
                    </div>`;
                }).join('') : '<div style="padding:8px 10px;font-size:12px;color:var(--text-light);">Bullpen data not available</div>'}
            </div>
        </div>
    `;
    
    rosterEl.innerHTML = html;
}

// ===== VIEW MANAGEMENT =====
function showView(view) {
    document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
    document.getElementById(`${view}-view`).style.display = 'block';
}
function showGames() { showView('games'); currentGame = null; }
function showLoading(show) { document.getElementById('loading').style.display = show ? 'block' : 'none'; }
