import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
const demoMode = argv.includes('--demo');
const username = readArgument('--username')
  ?? process.env.GITHUB_USERNAME
  ?? process.env.GITHUB_REPOSITORY_OWNER
  ?? process.env.GITHUB_REPOSITORY?.split('/')[0]
  ?? 'F-Keller';
const outputDir = path.resolve(readArgument('--output-dir') ?? 'assets');
const token = process.env.RPG_GRAPH_TOKEN
  || process.env.GH_TOKEN
  || process.env.GITHUB_TOKEN;

const adventure = demoMode
  ? createDemoAdventure(username)
  : await loadAdventure(username, token);

await mkdir(outputDir, { recursive: true });

for (const [themeName, fileName] of [
  ['light', 'github-rpg.svg'],
  ['dark', 'github-rpg-dark.svg'],
]) {
  const svg = renderRpgSvg({
    username,
    adventure,
    themeName,
    demoMode,
  });
  const filePath = path.join(outputDir, fileName);
  await writeFile(filePath, svg, 'utf8');
  console.log(`Gerado: ${filePath}`);
}

await writeFile(
  path.join(outputDir, 'github-rpg-data.json'),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    username,
    source: adventure.source,
    totalContributions: adventure.totalContributions,
    activeDays: adventure.activeDays,
    dominantTechnologies: adventure.dominantTechnologies,
    encounters: adventure.encounters.map((encounter) => ({
      date: encounter.date,
      contributionCount: encounter.contributionCount,
      technology: encounter.technology,
      creature: encounter.creature,
      repository: encounter.repository,
    })),
  }, null, 2),
  'utf8',
);

function readArgument(name) {
  const withEquals = argv.find((item) => item.startsWith(`${name}=`));
  if (withEquals) return withEquals.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function loadAdventure(login, authToken) {
  const errors = [];

  if (authToken) {
    try {
      const graphData = await fetchAdventureFromGraphQL(login, authToken);
      return buildAdventure(graphData, login, 'github-graphql');
    } catch (error) {
      errors.push(`GraphQL: ${error.message}`);
    }
  } else {
    errors.push('GraphQL: nenhum token disponível');
  }

  try {
    const calendar = await fetchCalendarFromPublicProfile(login);
    return buildAdventure({
      calendar,
      commitRepositories: [],
    }, login, 'github-public-profile');
  } catch (error) {
    errors.push(`perfil público: ${error.message}`);
  }

  throw new Error(
    `Não foi possível montar o mapa RPG de ${login}. ${errors.join(' | ')}`,
  );
}

async function fetchAdventureFromGraphQL(login, authToken) {
  const query = `
    query GithubRpgAdventure($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                date
                contributionCount
                contributionLevel
                weekday
              }
            }
          }
          commitContributionsByRepository(maxRepositories: 100) {
            repository {
              nameWithOwner
              isPrivate
              primaryLanguage {
                name
                color
              }
              repositoryTopics(first: 20) {
                nodes {
                  topic {
                    name
                  }
                }
              }
            }
            contributions(first: 100, orderBy: { field: OCCURRED_AT, direction: DESC }) {
              nodes {
                occurredAt
                commitCount
                isRestricted
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'github-rpg-contribution-map/2.0',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ query, variables: { login } }),
  });

  if (!response.ok) {
    throw new Error(`GitHub GraphQL respondeu HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((item) => item.message).join('; '));
  }

  const collection = payload.data?.user?.contributionsCollection;
  if (!collection?.contributionCalendar) {
    throw new Error('usuário ou calendário não encontrado');
  }

  const calendar = normalizeCalendar({
    days: collection.contributionCalendar.weeks.flatMap((week) =>
      week.contributionDays.map((day) => ({
        date: day.date,
        level: contributionLevelToNumber(day.contributionLevel),
        contributionCount: day.contributionCount,
      })),
    ),
    totalContributions: collection.contributionCalendar.totalContributions,
  });

  return {
    calendar,
    commitRepositories: collection.commitContributionsByRepository ?? [],
  };
}

async function fetchCalendarFromPublicProfile(login) {
  const response = await fetch(
    `https://github.com/users/${encodeURIComponent(login)}/contributions`,
    {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'github-rpg-contribution-map/2.0',
      },
    },
  );

  if (!response.ok) {
    throw new Error(`GitHub respondeu HTTP ${response.status}`);
  }

  const html = await response.text();
  const tags = html.match(/<[^>]+\bdata-date=(?:"[^"]+"|'[^']+')[^>]*>/gi) ?? [];
  const byDate = new Map();

  for (const tag of tags) {
    const date = getHtmlAttribute(tag, 'data-date');
    const levelText = getHtmlAttribute(tag, 'data-level');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || levelText == null) continue;
    const level = clamp(Number.parseInt(levelText, 10) || 0, 0, 4);
    const countText = getHtmlAttribute(tag, 'data-count');
    const parsedCount = Number.parseInt(countText ?? '', 10);
    byDate.set(date, {
      date,
      level,
      contributionCount: Number.isFinite(parsedCount)
        ? parsedCount
        : estimatedCountFromLevel(level),
    });
  }

  if (byDate.size < 300) {
    throw new Error(`foram encontrados somente ${byDate.size} dias`);
  }

  const plainText = decodeHtmlEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' '),
  );
  const totalMatch = plainText.match(/([\d,.]+)\s+contributions?\s+in\s+the\s+last\s+year/i);
  const parsedTotal = totalMatch
    ? Number.parseInt(totalMatch[1].replace(/[^\d]/g, ''), 10)
    : Number.NaN;

  return normalizeCalendar({
    days: [...byDate.values()],
    totalContributions: Number.isFinite(parsedTotal) ? parsedTotal : undefined,
  });
}

function buildAdventure({ calendar, commitRepositories }, login, source) {
  const technologyByDate = new Map();
  const overallTechnologyScores = new Map();

  for (const item of commitRepositories) {
    const repo = item.repository;
    if (!repo) continue;
    const technology = detectTechnology(repo);
    const repoName = repo.nameWithOwner ?? 'repositório privado';

    for (const contribution of item.contributions?.nodes ?? []) {
      const date = String(contribution.occurredAt ?? '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const count = Math.max(1, Number(contribution.commitCount) || 1);
      const entry = technologyByDate.get(date) ?? new Map();
      const current = entry.get(technology.name) ?? {
        score: 0,
        technology,
        repositories: new Map(),
      };
      current.score += count;
      current.repositories.set(repoName, (current.repositories.get(repoName) ?? 0) + count);
      entry.set(technology.name, current);
      technologyByDate.set(date, entry);
      overallTechnologyScores.set(
        technology.name,
        (overallTechnologyScores.get(technology.name) ?? 0) + count,
      );
    }
  }

  const overallSorted = [...overallTechnologyScores.entries()]
    .sort((a, b) => b[1] - a[1]);
  const overallFallback = overallSorted[0]?.[0] ?? 'Code';
  const byTechnologyName = new Map();
  for (const item of commitRepositories) {
    if (!item.repository) continue;
    const technology = detectTechnology(item.repository);
    byTechnologyName.set(technology.name, technology);
  }
  byTechnologyName.set('Code', technologyDefinition('Code'));
  byTechnologyName.set('Private Code', technologyDefinition('Private Code'));

  const flatDays = calendar.weeks.flatMap((week) => week.contributionDays);
  const dateLookup = new Map();

  for (const day of flatDays) {
    const scores = technologyByDate.get(day.date);
    if (scores?.size) {
      const winner = [...scores.values()].sort((a, b) => b.score - a.score)[0];
      const repository = [...winner.repositories.entries()]
        .sort((a, b) => b[1] - a[1])[0]?.[0];
      dateLookup.set(day.date, {
        ...winner.technology,
        repository,
        technologyScore: winner.score,
      });
    } else if (day.contributionCount > 0) {
      const fallbackName = source === 'github-public-profile'
        ? 'Code'
        : overallFallback;
      dateLookup.set(day.date, {
        ...(byTechnologyName.get(fallbackName) ?? technologyDefinition(fallbackName)),
        repository: source === 'github-public-profile'
          ? 'detalhes indisponíveis sem GraphQL'
          : 'atividade privada ou sem linguagem detectada',
        technologyScore: day.contributionCount,
      });
    }
  }

  const daysWithTechnology = flatDays.map((day) => ({
    ...day,
    ...(dateLookup.get(day.date) ?? {}),
  }));

  const latestDate = daysWithTechnology.at(-1)?.date ?? formatDate(new Date());
  const seed = `${login}:${latestDate}:${calendar.totalContributions}:${formatDate(new Date())}`;
  const random = mulberry32(hashString(seed));
  const encounterPool = daysWithTechnology.filter((day) => day.contributionCount > 0);
  const encounters = selectEncounters(encounterPool, random, 2).map((day) => {
    const technology = day.name ?? 'Code';
    const definition = technologyDefinition(technology, day.color);
    return {
      ...day,
      technology,
      creature: definition.creature,
      color: definition.color,
      accent: definition.accent,
      move: definition.move,
      symbol: definition.symbol,
      sprite: definition.sprite,
      repository: day.repository ?? 'atividade do GitHub',
    };
  });

  const dominantTechnologies = overallSorted.slice(0, 8).map(([name, commits]) => ({
    name,
    commits,
  }));

  return {
    ...calendar,
    source,
    daysWithTechnology,
    encounters,
    dominantTechnologies,
    seed,
  };
}

function selectEncounters(pool, random, amount) {
  if (pool.length === 0) {
    return [
      { date: formatDate(new Date()), contributionCount: 1, level: 1, name: 'Code' },
      { date: formatDate(new Date()), contributionCount: 1, level: 1, name: 'JavaScript' },
    ].slice(0, amount);
  }

  const shuffled = [...pool]
    .map((item) => ({ item, weight: random() }))
    .sort((a, b) => a.weight - b.weight)
    .map(({ item }) => item);
  const selected = [];
  const usedTechnologies = new Set();

  for (const item of shuffled) {
    const technology = item.name ?? 'Code';
    if (usedTechnologies.has(technology) && shuffled.length > amount) continue;
    selected.push(item);
    usedTechnologies.add(technology);
    if (selected.length === amount) break;
  }

  while (selected.length < amount) {
    selected.push(shuffled[selected.length % shuffled.length]);
  }

  return selected;
}

function detectTechnology(repository) {
  const topics = (repository.repositoryTopics?.nodes ?? [])
    .map((node) => node?.topic?.name?.toLowerCase())
    .filter(Boolean);
  const haystack = [
    ...topics,
    String(repository.nameWithOwner ?? '').toLowerCase(),
  ].join(' ');

  const topicRules = [
    ['Laravel', ['laravel']],
    ['Next.js', ['nextjs', 'next-js']],
    ['React', ['react', 'reactjs']],
    ['Vue', ['vue', 'vuejs']],
    ['Angular', ['angular']],
    ['Node.js', ['nodejs', 'node-js']],
    ['Docker', ['docker', 'container']],
    ['MySQL', ['mysql']],
    ['PostgreSQL', ['postgres', 'postgresql']],
    ['Django', ['django']],
    ['Flask', ['flask']],
    ['Spring', ['spring', 'spring-boot']],
    ['Flutter', ['flutter']],
    ['Unity', ['unity']],
  ];

  for (const [name, terms] of topicRules) {
    if (terms.some((term) => haystack.includes(term))) {
      return technologyDefinition(name, repository.primaryLanguage?.color);
    }
  }

  return technologyDefinition(
    repository.primaryLanguage?.name ?? (repository.isPrivate ? 'Private Code' : 'Code'),
    repository.primaryLanguage?.color,
  );
}

function technologyDefinition(name, preferredColor) {
  const normalized = normalizeTechnologyName(name);
  const definitions = {
    Laravel: { creature: 'LARAVAGON', color: '#ef3340', accent: '#8d111b', move: 'ROTA API', symbol: 'L', sprite: 'dragon' },
    PHP: { creature: 'PHPHANTOM', color: '#777bb4', accent: '#4f568f', move: 'ARTISAN BLAST', symbol: 'PHP', sprite: 'phantom' },
    JavaScript: { creature: 'SCRIPTZAP', color: '#f1e05a', accent: '#9a7d00', move: 'ASYNC SHOCK', symbol: 'JS', sprite: 'spark' },
    TypeScript: { creature: 'TYPETITAN', color: '#3178c6', accent: '#174d82', move: 'STRICT BEAM', symbol: 'TS', sprite: 'titan' },
    React: { creature: 'REACTRON', color: '#61dafb', accent: '#087ea4', move: 'HOOK SPIN', symbol: '⚛', sprite: 'atom' },
    'Next.js': { creature: 'NEXTVOID', color: '#202124', accent: '#656d76', move: 'SERVER RUSH', symbol: 'N', sprite: 'void' },
    Vue: { creature: 'VUEMOSS', color: '#41b883', accent: '#236b4f', move: 'COMPOSE VINE', symbol: 'V', sprite: 'moss' },
    Angular: { creature: 'ANGULORD', color: '#dd0031', accent: '#8d0020', move: 'MODULE EDGE', symbol: 'A', sprite: 'shield' },
    Python: { creature: 'PYSERPENT', color: '#3572a5', accent: '#ffd343', move: 'VENOM SCRIPT', symbol: 'PY', sprite: 'serpent' },
    Django: { creature: 'DJANGROOT', color: '#0c4b33', accent: '#44b78b', move: 'ORM ROOT', symbol: 'DJ', sprite: 'root' },
    Flask: { creature: 'FLASKLING', color: '#5b5b5b', accent: '#d0d7de', move: 'MICRO BREW', symbol: 'F', sprite: 'flask' },
    Java: { creature: 'JAVAGMA', color: '#b07219', accent: '#e76f00', move: 'JVM FLARE', symbol: 'J', sprite: 'golem' },
    Spring: { creature: 'SPRINGALE', color: '#6db33f', accent: '#38761d', move: 'BEAN STORM', symbol: 'S', sprite: 'leaf' },
    HTML: { creature: 'TAGCRAB', color: '#e34c26', accent: '#8a2d18', move: 'SEMANTIC CLAW', symbol: '<>', sprite: 'crab' },
    CSS: { creature: 'STYLEFIN', color: '#563d7c', accent: '#264de4', move: 'CASCADE WAVE', symbol: '#', sprite: 'fin' },
    'C#': { creature: 'SHARPKNIGHT', color: '#178600', accent: '#68217a', move: 'LINQ SLASH', symbol: 'C#', sprite: 'knight' },
    'C++': { creature: 'PLUSDRake'.toUpperCase(), color: '#f34b7d', accent: '#00599c', move: 'POINTER FANG', symbol: 'C++', sprite: 'dragon' },
    C: { creature: 'COREBYTE', color: '#555555', accent: '#a8b9cc', move: 'MEMORY HIT', symbol: 'C', sprite: 'core' },
    Go: { creature: 'GOFIN', color: '#00add8', accent: '#007d9c', move: 'GOROUTINE DASH', symbol: 'GO', sprite: 'fin' },
    Rust: { creature: 'RUSTOR', color: '#dea584', accent: '#7a3b16', move: 'BORROW CRUSH', symbol: 'RS', sprite: 'gear' },
    Ruby: { creature: 'RUBYGEM', color: '#701516', accent: '#cc342d', move: 'RAILS RUSH', symbol: 'RB', sprite: 'gem' },
    Swift: { creature: 'SWIFTWING', color: '#f05138', accent: '#9a2617', move: 'ASYNC WING', symbol: 'SW', sprite: 'bird' },
    Kotlin: { creature: 'KOTLUNA', color: '#a97bff', accent: '#6c3bc7', move: 'COROUTINE MOON', symbol: 'KT', sprite: 'moon' },
    Dart: { creature: 'DARTFIN', color: '#00b4ab', accent: '#0175c2', move: 'WIDGET WAVE', symbol: 'D', sprite: 'fin' },
    Flutter: { creature: 'FLUTTERAY', color: '#54c5f8', accent: '#02569b', move: 'WIDGET RAY', symbol: 'FL', sprite: 'bird' },
    Shell: { creature: 'BASHGHOST', color: '#89e051', accent: '#2d6a28', move: 'PIPE HAUNT', symbol: '$', sprite: 'ghost' },
    PowerShell: { creature: 'POWERSHELLIX', color: '#012456', accent: '#5391fe', move: 'CMDLET PULSE', symbol: 'PS', sprite: 'serpent' },
    Docker: { creature: 'DOCKWHALE', color: '#2496ed', accent: '#0b5fa5', move: 'CONTAINER TIDE', symbol: '▦', sprite: 'whale' },
    'Node.js': { creature: 'NODEMANTIS', color: '#43853d', accent: '#215732', move: 'EVENT LOOP', symbol: 'N', sprite: 'mantis' },
    MySQL: { creature: 'QUERYFIN', color: '#4479a1', accent: '#f29111', move: 'INDEX SPLASH', symbol: 'SQL', sprite: 'fin' },
    PostgreSQL: { creature: 'POSTGRELEPH', color: '#336791', accent: '#1b365d', move: 'JOIN CHARGE', symbol: 'PG', sprite: 'phantom' },
    Unity: { creature: 'UNITYCUBE', color: '#222c37', accent: '#e9ecef', move: 'SCENE BURST', symbol: 'U', sprite: 'titan' },
    'Private Code': { creature: 'CRYPTOMON', color: '#6e7781', accent: '#24292f', move: 'SECRET COMMIT', symbol: '?', sprite: 'void' },
    Code: { creature: 'CODESLIME', color: '#2da44e', accent: '#116329', move: 'COMMIT SPLASH', symbol: '</>', sprite: 'slime' },
  };

  const definition = definitions[normalized] ?? {
    ...definitions.Code,
    creature: `${sanitizeCreatureName(normalized)}MON`.slice(0, 12),
    symbol: normalized.slice(0, 3).toUpperCase(),
  };

  return {
    name: normalized,
    ...definition,
    color: preferredColor || definition.color,
  };
}

function normalizeTechnologyName(value) {
  const raw = String(value ?? 'Code').trim();
  const aliases = {
    JavaScript: 'JavaScript',
    TypeScript: 'TypeScript',
    Python: 'Python',
    PHP: 'PHP',
    Blade: 'Laravel',
    Hack: 'PHP',
    Vue: 'Vue',
    HTML: 'HTML',
    CSS: 'CSS',
    SCSS: 'CSS',
    Less: 'CSS',
    Java: 'Java',
    Kotlin: 'Kotlin',
    Swift: 'Swift',
    Ruby: 'Ruby',
    Go: 'Go',
    Rust: 'Rust',
    C: 'C',
    'C++': 'C++',
    'C#': 'C#',
    Shell: 'Shell',
    PowerShell: 'PowerShell',
    Dockerfile: 'Docker',
    Dart: 'Dart',
  };
  return aliases[raw] ?? raw;
}

function renderRpgSvg({ username: login, adventure, themeName, demoMode: isDemo }) {
  const themes = {
    light: {
      page: '#fffdf4',
      frame: '#2f3d2e',
      frameInner: '#f5efd4',
      text: '#253025',
      muted: '#647064',
      grass: '#a8cf72',
      grassAlt: '#8fbe64',
      grassDark: '#477a43',
      grassLight: '#d5e9a7',
      dirt: '#e2c67d',
      dirtDark: '#b28e4f',
      water: '#75b9c7',
      waterLight: '#b7e1e7',
      tree: '#3e7840',
      treeDark: '#244b2b',
      panel: '#fff8dc',
      panelBorder: '#38463a',
      empty: '#dbe8b8',
      levels: ['#dbe8b8', '#9be96e', '#55c75d', '#2f9b4a', '#176b3a'],
      battleSky: '#d7f0c4',
      battleGround: '#a8cf72',
      battleFar: '#6da05f',
      battleText: '#1f2521',
      hp: '#45ad57',
      hpLow: '#e7b843',
      shadow: '#1a2b1d',
      white: '#ffffff',
      black: '#111827',
      flash: '#ffffff',
    },
    dark: {
      page: '#07110d',
      frame: '#70856f',
      frameInner: '#101c16',
      text: '#e5f0e5',
      muted: '#a5b3a5',
      grass: '#244f35',
      grassAlt: '#1e422d',
      grassDark: '#102b20',
      grassLight: '#39704c',
      dirt: '#6c5b35',
      dirtDark: '#3f321e',
      water: '#285b67',
      waterLight: '#3f7d89',
      tree: '#1f5230',
      treeDark: '#0c2d1c',
      panel: '#101a15',
      panelBorder: '#8aa08a',
      empty: '#193023',
      levels: ['#193023', '#174a2d', '#176b36', '#239447', '#39d353'],
      battleSky: '#16392a',
      battleGround: '#28563a',
      battleFar: '#1d452e',
      battleText: '#edf7ed',
      hp: '#39d353',
      hpLow: '#d9a441',
      shadow: '#000000',
      white: '#f0f6fc',
      black: '#010409',
      flash: '#ffffff',
    },
  };

  const theme = themes[themeName];
  const width = 960;
  const height = 430;
  const duration = 38;
  const gridX = 56;
  const gridY = 126;
  const tileSize = 14;
  const tileStep = 16;
  const gridWidth = (adventure.weeks.length - 1) * tileStep + tileSize;
  const gridHeight = 6 * tileStep + tileSize;
  const cells = [];

  adventure.weeks.forEach((week, column) => {
    week.contributionDays.forEach((day, row) => {
      const enriched = adventure.daysWithTechnology.find((item) => item.date === day.date) ?? day;
      cells.push({
        ...enriched,
        column,
        row,
        x: gridX + column * tileStep,
        y: gridY + row * tileStep,
      });
    });
  });

  const random = mulberry32(hashString(`${adventure.seed}:${themeName}:route`));
  const routeRows = buildRouteRows(adventure.weeks, random);
  const routePoints = routeRows.map((row, column) => ({
    x: gridX + column * tileStep + tileSize / 2,
    y: gridY + row * tileStep + tileSize / 2,
  }));
  const playerStart = routePoints[0] ?? { x: gridX, y: gridY };
  const motionPath = routePoints
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${round(point.x - playerStart.x)} ${round(point.y - playerStart.y)}`)
    .join(' ');

  const encounterTimings = [8.2, 23.4].slice(0, adventure.encounters.length);
  const battleLength = 7.4;
  const selectedCells = adventure.encounters.map((encounter) =>
    cells.find((cell) => cell.date === encounter.date)
      ?? cells.find((cell) => cell.contributionCount > 0)
      ?? cells[0],
  );

  const monthLabels = buildMonthLabels(adventure.weeks, gridX, tileStep);
  const tileMarkup = cells.map((cell) => renderMapTile(cell, theme, tileSize)).join('');
  const routeMarkup = renderRoute(routePoints, theme);
  const treeMarkup = renderBorderTrees(theme, width, height, random);
  const encounterMarkers = selectedCells.map((cell, index) =>
    renderEncounterMarker(cell, encounterTimings[index] ?? 0, duration, theme, index),
  ).join('');
  const battleMarkup = adventure.encounters.map((encounter, index) =>
    renderBattleScene({
      encounter,
      index,
      start: encounterTimings[index],
      end: encounterTimings[index] + battleLength,
      duration,
      theme,
      width,
      height,
      username: login,
    }),
  ).join('');
  const transitionMarkup = adventure.encounters.map((_, index) =>
    renderBattleTransition(encounterTimings[index], duration, theme, width, height, index),
  ).join('');
  const legend = buildTechnologyLegend(adventure, theme);
  const sourceLabel = isDemo ? 'PRÉVIA DEMONSTRATIVA' : 'ATUALIZADO PELO GITHUB ACTIONS';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc" shape-rendering="crispEdges">
  <title id="title">Mapa RPG de contribuições de ${escapeXml(login)}</title>
  <desc id="desc">Um programador pixelado caminha pelo calendário de contribuições e enfrenta criaturas que representam as tecnologias predominantes dos commits. O companheiro do jogador é o Octocat.</desc>

  <defs>
    <pattern id="grass-pattern" width="16" height="16" patternUnits="userSpaceOnUse">
      <rect width="16" height="16" fill="${theme.grass}" />
      <rect x="2" y="3" width="2" height="4" fill="${theme.grassAlt}" />
      <rect x="11" y="9" width="2" height="3" fill="${theme.grassLight}" />
      <rect x="5" y="13" width="3" height="1" fill="${theme.grassDark}" opacity=".45" />
    </pattern>
    <pattern id="water-pattern" width="24" height="12" patternUnits="userSpaceOnUse">
      <rect width="24" height="12" fill="${theme.water}" />
      <rect x="2" y="3" width="9" height="2" fill="${theme.waterLight}" opacity=".75" />
      <rect x="14" y="8" width="7" height="2" fill="${theme.waterLight}" opacity=".5" />
    </pattern>
    <filter id="pixel-shadow" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="4" dy="4" stdDeviation="0" flood-color="${theme.shadow}" flood-opacity=".42" />
    </filter>
    <clipPath id="map-window">
      <rect x="22" y="76" width="916" height="244" rx="8" />
    </clipPath>
  </defs>

  <rect width="${width}" height="${height}" fill="${theme.page}" />
  <rect x="8" y="8" width="944" height="414" rx="14" fill="${theme.frame}" />
  <rect x="14" y="14" width="932" height="402" rx="10" fill="${theme.frameInner}" />

  <g font-family="ui-monospace, SFMono-Regular, Consolas, Liberation Mono, monospace">
    <text x="32" y="41" fill="${theme.text}" font-size="18" font-weight="800" letter-spacing="1">${escapeXml(login.toUpperCase())} · CODEMON ADVENTURE</text>
    <text x="32" y="60" fill="${theme.muted}" font-size="10">O CALENDÁRIO VIROU UM MAPA RPG · ENCONTROS GERADOS PELOS COMMITS</text>
    <text x="928" y="41" fill="${theme.muted}" font-size="9" text-anchor="end" letter-spacing="1">${sourceLabel}</text>

    <g clip-path="url(#map-window)">
      <rect x="22" y="76" width="916" height="244" fill="url(#grass-pattern)" />
      <rect x="22" y="76" width="916" height="24" fill="url(#water-pattern)" />
      <rect x="22" y="296" width="916" height="24" fill="url(#water-pattern)" />
      ${treeMarkup}
      <rect x="42" y="109" width="876" height="144" rx="8" fill="${theme.grassLight}" opacity=".38" />
      ${routeMarkup}
      ${tileMarkup}
      ${encounterMarkers}

      <g transform="translate(${round(playerStart.x - 8)} ${round(playerStart.y - 17)})" filter="url(#pixel-shadow)">
        ${renderTrainerSprite(theme)}
        <animateMotion dur="${duration}s" repeatCount="indefinite" path="${motionPath}" calcMode="linear" />
      </g>
    </g>

    ${monthLabels.map((label) => `<text x="${round(label.x)}" y="111" fill="${theme.muted}" font-size="8" font-weight="700">${label.text}</text>`).join('')}
    <text x="36" y="141" fill="${theme.muted}" font-size="8" text-anchor="end">DOM</text>
    <text x="36" y="173" fill="${theme.muted}" font-size="8" text-anchor="end">TER</text>
    <text x="36" y="205" fill="${theme.muted}" font-size="8" text-anchor="end">QUI</text>
    <text x="36" y="237" fill="${theme.muted}" font-size="8" text-anchor="end">SÁB</text>

    <rect x="28" y="332" width="904" height="68" rx="8" fill="${theme.panel}" stroke="${theme.panelBorder}" stroke-width="3" />
    <text x="47" y="355" fill="${theme.text}" font-size="12" font-weight="800">AVENTURA DE ${escapeXml(login.toUpperCase())}</text>
    <text x="47" y="375" fill="${theme.muted}" font-size="10">${formatNumber(adventure.totalContributions)} contribuições · ${formatNumber(adventure.activeDays)} dias ativos · companheiro: OCTOCAT</text>
    ${legend}
    <text x="47" y="392" fill="${theme.muted}" font-size="8">Cada encontro usa a tecnologia predominante nos commits daquele dia. A sequência muda na atualização diária.</text>

    ${transitionMarkup}
    ${battleMarkup}
  </g>
</svg>`;
}

function renderMapTile(cell, theme, tileSize) {
  const fill = theme.levels[cell.level] ?? theme.empty;
  const label = cell.contributionCount > 0
    ? `${cell.date}: ${cell.contributionCount} contribuição${cell.contributionCount === 1 ? '' : 'ões'} · ${cell.name ?? 'tecnologia não identificada'}${cell.repository ? ` · ${cell.repository}` : ''}`
    : `${cell.date}: sem contribuições`;
  const x = round(cell.x);
  const y = round(cell.y);
  const decoration = renderTileDecoration(cell, theme, tileSize);
  return `
    <g>
      <rect x="${x}" y="${y}" width="${tileSize}" height="${tileSize}" fill="${fill}" stroke="${theme.grassDark}" stroke-width="1">
        <title>${escapeXml(label)}</title>
      </rect>
      ${decoration}
    </g>`;
}

function renderTileDecoration(cell, theme, tileSize) {
  const x = cell.x;
  const y = cell.y;
  if (cell.level === 0) {
    return `<rect x="${round(x + 3)}" y="${round(y + 9)}" width="2" height="3" fill="${theme.grassAlt}" opacity=".45" />`;
  }
  if (cell.level === 1) {
    return `<path d="M ${round(x + 3)} ${round(y + 11)} l 2 -4 l 1 4 M ${round(x + 9)} ${round(y + 12)} l 1 -5 l 2 5" stroke="${theme.grassDark}" stroke-width="1" fill="none" />`;
  }
  if (cell.level === 2) {
    return `<rect x="${round(x + 3)}" y="${round(y + 3)}" width="3" height="3" fill="${theme.white}" /><rect x="${round(x + 4)}" y="${round(y + 4)}" width="1" height="1" fill="${theme.hpLow}" /><path d="M ${round(x + 10)} ${round(y + 12)} l 1 -5 l 2 5" stroke="${theme.grassDark}" stroke-width="1" />`;
  }
  if (cell.level === 3) {
    return `<rect x="${round(x + 3)}" y="${round(y + 5)}" width="8" height="6" fill="${theme.tree}" /><rect x="${round(x + 5)}" y="${round(y + 3)}" width="4" height="2" fill="${theme.treeDark}" /><rect x="${round(x + 6)}" y="${round(y + 11)}" width="2" height="2" fill="${theme.dirtDark}" />`;
  }
  return `<path d="M ${round(x + 7)} ${round(y + 2)} l 4 5 l -4 5 l -4 -5 z" fill="${theme.waterLight}" stroke="${theme.white}" stroke-width="1" /><rect x="${round(x + 6)}" y="${round(y + 5)}" width="2" height="5" fill="${theme.white}" opacity=".75" />`;
}

function buildRouteRows(weeks, random) {
  let row = 3;
  const rows = [];
  for (let column = 0; column < weeks.length; column += 1) {
    const activeRows = weeks[column].contributionDays
      .map((day, index) => ({ day, index }))
      .filter(({ day }) => day.contributionCount > 0)
      .map(({ index }) => index);
    const candidates = [row, clamp(row - 1, 0, 6), clamp(row + 1, 0, 6)];
    const activeCandidate = candidates.find((candidate) => activeRows.includes(candidate));
    if (activeCandidate != null && random() < 0.72) {
      row = activeCandidate;
    } else {
      const step = random() < 0.25 ? -1 : random() > 0.75 ? 1 : 0;
      row = clamp(row + step, 0, 6);
    }
    rows.push(row);
  }
  return rows;
}

function renderRoute(points, theme) {
  if (points.length < 2) return '';
  const pointList = points.map((point) => `${round(point.x)},${round(point.y)}`).join(' ');
  return `
    <polyline points="${pointList}" fill="none" stroke="${theme.dirtDark}" stroke-width="10" stroke-linecap="square" stroke-linejoin="round" opacity=".7" />
    <polyline points="${pointList}" fill="none" stroke="${theme.dirt}" stroke-width="7" stroke-linecap="square" stroke-linejoin="round" />
    <polyline points="${pointList}" fill="none" stroke="${theme.frameInner}" stroke-width="1" stroke-dasharray="2 5" opacity=".55" />`;
}

function renderBorderTrees(theme, width, height, random) {
  const trees = [];
  for (let x = 28; x < width - 28; x += 28) {
    if (random() < 0.2) continue;
    trees.push(renderTree(x, 88 + (Math.floor(random() * 2) * 4), theme));
    if (random() > 0.15) trees.push(renderTree(x + 12, 284 + (Math.floor(random() * 2) * 4), theme));
  }
  return trees.join('');
}

function renderTree(x, y, theme) {
  return `<g transform="translate(${round(x)} ${round(y)})">
    <rect x="7" y="13" width="5" height="8" fill="${theme.dirtDark}" />
    <rect x="2" y="6" width="15" height="12" fill="${theme.treeDark}" />
    <rect x="5" y="2" width="10" height="15" fill="${theme.tree}" />
    <rect x="7" y="4" width="4" height="4" fill="${theme.grassLight}" opacity=".65" />
  </g>`;
}

function renderTrainerSprite(theme) {
  return `
    <g>
      <ellipse cx="8" cy="25" rx="7" ry="3" fill="${theme.shadow}" opacity=".28" />
      <g id="trainer-step-a">
        <rect x="5" y="1" width="8" height="3" fill="#29344a" />
        <rect x="3" y="4" width="12" height="4" fill="#29344a" />
        <rect x="5" y="7" width="8" height="6" fill="#e8b991" />
        <rect x="4" y="13" width="10" height="7" fill="#2f81f7" />
        <rect x="2" y="14" width="3" height="5" fill="#f85149" />
        <rect x="13" y="14" width="3" height="5" fill="#f85149" />
        <rect x="5" y="20" width="4" height="5" fill="#30363d" />
        <rect x="10" y="20" width="4" height="4" fill="#30363d" />
        <rect x="6" y="10" width="2" height="2" fill="${theme.black}" />
        <rect x="11" y="10" width="2" height="2" fill="${theme.black}" />
        <rect x="6" y="15" width="6" height="2" fill="${theme.white}" opacity=".75" />
        <animate attributeName="opacity" dur=".36s" repeatCount="indefinite" values="1;0;1" />
      </g>
      <g opacity="0">
        <rect x="5" y="1" width="8" height="3" fill="#29344a" />
        <rect x="3" y="4" width="12" height="4" fill="#29344a" />
        <rect x="5" y="7" width="8" height="6" fill="#e8b991" />
        <rect x="4" y="13" width="10" height="7" fill="#2f81f7" />
        <rect x="2" y="15" width="3" height="5" fill="#f85149" />
        <rect x="13" y="13" width="3" height="5" fill="#f85149" />
        <rect x="5" y="20" width="4" height="4" fill="#30363d" />
        <rect x="10" y="20" width="4" height="5" fill="#30363d" />
        <rect x="6" y="10" width="2" height="2" fill="${theme.black}" />
        <rect x="11" y="10" width="2" height="2" fill="${theme.black}" />
        <rect x="6" y="15" width="6" height="2" fill="${theme.white}" opacity=".75" />
        <animate attributeName="opacity" dur=".36s" repeatCount="indefinite" values="0;1;0" />
      </g>
    </g>`;
}

function renderEncounterMarker(cell, start, duration, theme, index) {
  if (!cell || !start) return '';
  const x = cell.x + 7;
  const y = cell.y + 7;
  const pulseStart = clamp((start - 1.8) / duration, 0, 1);
  const pulseEnd = clamp(start / duration, 0, 1);
  const keyTimes = monotonicKeyTimes([0, pulseStart, pulseStart + 0.002, pulseEnd, pulseEnd + 0.002, 1]);
  return `<g opacity="0">
    <rect x="${round(x - 9)}" y="${round(y - 9)}" width="18" height="18" fill="none" stroke="${theme.white}" stroke-width="2" />
    <rect x="${round(x - 6)}" y="${round(y - 6)}" width="12" height="12" fill="none" stroke="${theme.hpLow}" stroke-width="2" />
    <text x="${round(x)}" y="${round(y + 3)}" fill="${theme.black}" font-size="9" font-weight="900" text-anchor="middle">!</text>
    <animate attributeName="opacity" dur="${duration}s" repeatCount="indefinite" values="0;0;1;1;0;0" keyTimes="${keyTimes}" />
    <animateTransform attributeName="transform" type="scale" additive="sum" dur="1s" repeatCount="indefinite" values="1;1.12;1" />
  </g>`;
}

function renderBattleTransition(start, duration, theme, width, height, index) {
  if (start == null) return '';
  const flashStart = (start - 0.55) / duration;
  const flashPeak = (start - 0.28) / duration;
  const flashEnd = (start + 0.12) / duration;
  const keyTimes = monotonicKeyTimes([0, flashStart, flashPeak, flashEnd, 1]);
  return `<g opacity="0">
    <rect x="14" y="14" width="932" height="402" rx="10" fill="${theme.flash}" />
    <animate attributeName="opacity" dur="${duration}s" repeatCount="indefinite" values="0;0;.95;0;0" keyTimes="${keyTimes}" />
  </g>`;
}

function renderBattleScene({ encounter, index, start, end, duration, theme, width, height, username }) {
  const visible = opacityTimeline(start, end, duration, 0.22);
  const intro = opacityTimeline(start + 0.35, start + 2.25, duration, 0.08);
  const attack = opacityTimeline(start + 2.35, start + 4.65, duration, 0.08);
  const result = opacityTimeline(start + 4.75, end - 0.2, duration, 0.08);
  const enemy = technologyDefinition(encounter.technology, encounter.color);
  const level = clamp(4 + Math.ceil(Math.log2(encounter.contributionCount + 1) * 4), 5, 99);
  const playerLevel = clamp(20 + Math.ceil(Math.sqrt(Math.max(1, encounter.contributionCount)) * 2), 20, 99);
  const battleTitle = `${enemy.creature} · ${encounter.technology}`;
  const statusRepo = truncateText(encounter.repository ?? 'atividade do GitHub', 43);
  const attackStart = start + 3.15;
  const attackEnd = attackStart + 0.82;
  const projectileOpacity = opacityTimeline(attackStart, attackEnd, duration, 0.02);
  const shake = shakeTimeline(attackEnd, duration);
  const enemyHp = Math.max(18, 100 - Math.min(72, encounter.contributionCount * 4));

  return `<g opacity="0">
    <animate attributeName="opacity" dur="${duration}s" repeatCount="indefinite" values="${visible.values}" keyTimes="${visible.keyTimes}" />

    <rect x="14" y="14" width="932" height="402" rx="10" fill="${theme.battleSky}" />
    <rect x="14" y="209" width="932" height="207" fill="${theme.battleGround}" />
    <path d="M 14 198 Q 150 140 292 196 T 566 190 T 946 184 L 946 247 L 14 247 Z" fill="${theme.battleFar}" opacity=".8" />
    <g opacity=".55">
      ${Array.from({ length: 18 }, (_, itemIndex) => {
        const x = 30 + itemIndex * 54 + (itemIndex % 3) * 6;
        const y = 184 + (itemIndex % 4) * 12;
        return `<path d="M ${x} ${y} l 5 -10 l 3 10 M ${x + 10} ${y + 2} l 4 -9 l 4 9" stroke="${theme.grassLight}" stroke-width="3" fill="none" />`;
      }).join('')}
    </g>

    <ellipse cx="725" cy="212" rx="116" ry="28" fill="${theme.shadow}" opacity=".24" />
    <ellipse cx="230" cy="314" rx="132" ry="31" fill="${theme.shadow}" opacity=".24" />

    <g transform="translate(655 80) scale(2.2)" filter="url(#pixel-shadow)">
      ${renderEnemySprite(enemy, theme)}
      <animateTransform attributeName="transform" type="translate" additive="sum" dur="${duration}s" repeatCount="indefinite" values="${shake.values}" keyTimes="${shake.keyTimes}" />
    </g>

    <g transform="translate(135 199) scale(2.45)" filter="url(#pixel-shadow)">
      ${renderOctocatSprite(theme)}
    </g>

    <g transform="translate(42 36)">
      <rect width="388" height="76" rx="5" fill="${theme.panel}" stroke="${theme.panelBorder}" stroke-width="4" />
      <text x="16" y="25" fill="${theme.battleText}" font-size="15" font-weight="900">${escapeXml(enemy.creature)}</text>
      <text x="348" y="25" fill="${theme.battleText}" font-size="13" font-weight="900" text-anchor="end">LV ${level}</text>
      <text x="16" y="43" fill="${theme.muted}" font-size="9">${escapeXml(encounter.technology.toUpperCase())} · ${escapeXml(formatDatePt(encounter.date))}</text>
      <text x="17" y="61" fill="${theme.muted}" font-size="8">HP</text>
      <rect x="42" y="52" width="325" height="12" fill="${theme.frame}" />
      <rect x="45" y="55" width="${round(319 * enemyHp / 100)}" height="6" fill="${enemyHp < 35 ? theme.hpLow : theme.hp}" />
    </g>

    <g transform="translate(520 246)">
      <rect width="390" height="76" rx="5" fill="${theme.panel}" stroke="${theme.panelBorder}" stroke-width="4" />
      <text x="16" y="25" fill="${theme.battleText}" font-size="15" font-weight="900">OCTOCAT</text>
      <text x="350" y="25" fill="${theme.battleText}" font-size="13" font-weight="900" text-anchor="end">LV ${playerLevel}</text>
      <text x="16" y="43" fill="${theme.muted}" font-size="9">COMPANHEIRO DE ${escapeXml(username.toUpperCase())}</text>
      <text x="17" y="61" fill="${theme.muted}" font-size="8">HP</text>
      <rect x="42" y="52" width="325" height="12" fill="${theme.frame}" />
      <rect x="45" y="55" width="319" height="6" fill="${theme.hp}" />
    </g>

    <g opacity="0">
      <animate attributeName="opacity" dur="${duration}s" repeatCount="indefinite" values="${projectileOpacity.values}" keyTimes="${projectileOpacity.keyTimes}" />
      <g transform="translate(285 245)">
        <rect x="-7" y="-7" width="14" height="14" fill="${theme.white}" stroke="${theme.black}" stroke-width="2" />
        <path d="M -4 1 h 3 v -5 h 6 M 1 -4 l 4 -4 M 5 -8 v 5 h 4" fill="none" stroke="#2f81f7" stroke-width="2" />
        <animateMotion dur="${duration}s" repeatCount="indefinite" path="M 0 0 C 130 -100 255 -112 405 -105" keyPoints="0;0;1;1" keyTimes="0;${round(attackStart / duration, 4)};${round(attackEnd / duration, 4)};1" calcMode="linear" />
      </g>
    </g>

    <rect x="28" y="332" width="904" height="68" rx="6" fill="${theme.panel}" stroke="${theme.panelBorder}" stroke-width="4" />

    <g opacity="0">
      <animate attributeName="opacity" dur="${duration}s" repeatCount="indefinite" values="${intro.values}" keyTimes="${intro.keyTimes}" />
      <text x="49" y="359" fill="${theme.battleText}" font-size="14" font-weight="900">UM ${escapeXml(enemy.creature)} SELVAGEM APARECEU!</text>
      <text x="49" y="382" fill="${theme.muted}" font-size="10">${escapeXml(battleTitle)} · ${escapeXml(statusRepo)}</text>
    </g>

    <g opacity="0">
      <animate attributeName="opacity" dur="${duration}s" repeatCount="indefinite" values="${attack.values}" keyTimes="${attack.keyTimes}" />
      <text x="49" y="359" fill="${theme.battleText}" font-size="14" font-weight="900">OCTOCAT USOU PULL REQUEST!</text>
      <text x="49" y="382" fill="${theme.muted}" font-size="10">O ataque encontrou ${formatNumber(encounter.contributionCount)} commit${encounter.contributionCount === 1 ? '' : 's'} de ${escapeXml(encounter.technology)}.</text>
    </g>

    <g opacity="0">
      <animate attributeName="opacity" dur="${duration}s" repeatCount="indefinite" values="${result.values}" keyTimes="${result.keyTimes}" />
      <text x="49" y="359" fill="${theme.battleText}" font-size="14" font-weight="900">SUPER EFETIVO! ${escapeXml(enemy.move)} FOI APRENDIDO.</text>
      <text x="49" y="382" fill="${theme.muted}" font-size="10">Dia ${escapeXml(formatDatePt(encounter.date))} registrado no mapa de contribuições.</text>
    </g>
  </g>`;
}

function renderOctocatSprite(theme) {
  const outline = theme.black;
  const body = theme.white;
  const face = theme.white;
  const accent = '#2f81f7';
  return `<g>
    <rect x="16" y="3" width="6" height="8" fill="${outline}" />
    <rect x="40" y="3" width="6" height="8" fill="${outline}" />
    <rect x="12" y="9" width="38" height="8" fill="${outline}" />
    <rect x="8" y="16" width="46" height="25" fill="${outline}" />
    <rect x="12" y="18" width="38" height="20" fill="${face}" />
    <rect x="18" y="23" width="5" height="6" fill="${outline}" />
    <rect x="39" y="23" width="5" height="6" fill="${outline}" />
    <rect x="29" y="30" width="5" height="4" fill="${outline}" />
    <rect x="20" y="36" width="22" height="5" fill="${outline}" />
    <rect x="14" y="40" width="34" height="23" fill="${outline}" />
    <rect x="19" y="43" width="24" height="17" fill="${body}" />
    <rect x="25" y="46" width="12" height="8" fill="${accent}" />
    <path d="M 15 47 h -9 v 7 h 8 M 47 48 h 9 v 6 h -8" fill="none" stroke="${outline}" stroke-width="5" />
    <path d="M 17 61 h -8 v 9 h 8 M 45 61 h 8 v 9 h -8" fill="none" stroke="${outline}" stroke-width="5" />
    <path d="M 46 42 C 62 35 67 46 60 53 C 55 58 64 64 69 58" fill="none" stroke="${outline}" stroke-width="5" />
    <rect x="24" y="12" width="14" height="3" fill="${accent}" />
  </g>`;
}

function renderEnemySprite(enemy, theme) {
  const color = enemy.color;
  const accent = enemy.accent;
  const outline = theme.black;
  const light = theme.white;
  const symbol = escapeXml(enemy.symbol);

  const base = {
    slime: `<rect x="11" y="25" width="42" height="26" fill="${outline}" /><rect x="15" y="18" width="34" height="29" fill="${color}" /><rect x="21" y="14" width="22" height="8" fill="${color}" /><rect x="22" y="29" width="5" height="6" fill="${outline}" /><rect x="38" y="29" width="5" height="6" fill="${outline}" /><rect x="29" y="39" width="7" height="3" fill="${outline}" />`,
    dragon: `<rect x="20" y="10" width="26" height="34" fill="${outline}" /><rect x="16" y="17" width="34" height="20" fill="${color}" /><rect x="24" y="6" width="6" height="10" fill="${accent}" /><rect x="39" y="4" width="6" height="12" fill="${accent}" /><rect x="23" y="22" width="5" height="5" fill="${light}" /><rect x="40" y="22" width="5" height="5" fill="${light}" /><rect x="27" y="23" width="2" height="3" fill="${outline}" /><rect x="41" y="23" width="2" height="3" fill="${outline}" /><path d="M 17 32 h -10 v 15 h 14 M 49 29 h 9 v 17 h -14" fill="none" stroke="${outline}" stroke-width="6" /><rect x="23" y="43" width="8" height="12" fill="${outline}" /><rect x="38" y="43" width="8" height="12" fill="${outline}" />`,
    phantom: `<rect x="14" y="11" width="38" height="36" fill="${outline}" /><rect x="18" y="7" width="30" height="37" fill="${color}" /><path d="M 18 44 h 8 l 4 8 l 6 -8 l 6 8 l 6 -8" fill="${color}" stroke="${outline}" stroke-width="4" /><rect x="23" y="21" width="6" height="8" fill="${light}" /><rect x="38" y="21" width="6" height="8" fill="${light}" /><rect x="25" y="24" width="3" height="4" fill="${outline}" /><rect x="40" y="24" width="3" height="4" fill="${outline}" />`,
    spark: `<path d="M 31 3 l 9 15 l 13 -2 l -5 13 l 11 9 l -15 4 l -2 14 l -12 -8 l -12 8 l -2 -14 l -15 -4 l 11 -9 l -5 -13 l 13 2 z" fill="${outline}" /><path d="M 31 9 l 7 13 l 10 -2 l -5 10 l 9 7 l -12 2 l -1 11 l -9 -7 l -9 7 l -1 -11 l -12 -2 l 9 -7 l -5 -10 l 10 2 z" fill="${color}" /><rect x="23" y="29" width="5" height="6" fill="${outline}" /><rect x="37" y="29" width="5" height="6" fill="${outline}" />`,
    titan: `<rect x="10" y="9" width="44" height="44" fill="${outline}" /><rect x="15" y="14" width="34" height="34" fill="${color}" /><rect x="20" y="20" width="24" height="10" fill="${accent}" /><rect x="21" y="34" width="8" height="7" fill="${light}" /><rect x="36" y="34" width="8" height="7" fill="${light}" /><rect x="14" y="52" width="13" height="7" fill="${outline}" /><rect x="37" y="52" width="13" height="7" fill="${outline}" />`,
    atom: `<circle cx="32" cy="31" r="8" fill="${color}" stroke="${outline}" stroke-width="4" /><ellipse cx="32" cy="31" rx="26" ry="10" fill="none" stroke="${outline}" stroke-width="5" /><ellipse cx="32" cy="31" rx="26" ry="10" transform="rotate(60 32 31)" fill="none" stroke="${color}" stroke-width="4" /><ellipse cx="32" cy="31" rx="26" ry="10" transform="rotate(-60 32 31)" fill="none" stroke="${accent}" stroke-width="4" /><rect x="29" y="28" width="6" height="6" fill="${light}" />`,
    void: `<circle cx="32" cy="31" r="27" fill="${outline}" /><circle cx="32" cy="31" r="20" fill="${color}" /><path d="M 17 20 l 15 24 l 15 -24" fill="none" stroke="${light}" stroke-width="5" /><rect x="29" y="26" width="6" height="6" fill="${accent}" />`,
    moss: `<path d="M 11 15 h 42 l -8 37 h -26 z" fill="${outline}" /><path d="M 17 20 h 30 l -7 26 h -16 z" fill="${color}" /><path d="M 23 8 l 9 12 l 9 -12" fill="none" stroke="${accent}" stroke-width="7" /><rect x="24" y="28" width="5" height="6" fill="${outline}" /><rect x="37" y="28" width="5" height="6" fill="${outline}" />`,
    shield: `<path d="M 32 4 l 24 9 v 18 c 0 16 -11 24 -24 29 c -13 -5 -24 -13 -24 -29 v -18 z" fill="${outline}" /><path d="M 32 10 l 18 7 v 14 c 0 11 -7 18 -18 23 c -11 -5 -18 -12 -18 -23 v -14 z" fill="${color}" /><rect x="23" y="25" width="18" height="7" fill="${light}" />`,
    serpent: `<path d="M 11 20 h 32 v 12 h -20 v 10 h 31 v 13 h -42 v -23 h 18 v -4 h -19 z" fill="${outline}" /><path d="M 15 16 h 30 v 12 h -20 v 8 h 31 v 15 h -39 v -13 h 18 v -6 h -20 z" fill="${color}" /><rect x="35" y="20" width="5" height="5" fill="${light}" /><rect x="37" y="21" width="2" height="2" fill="${outline}" />`,
    root: `<rect x="21" y="9" width="22" height="29" fill="${outline}" /><rect x="25" y="13" width="14" height="22" fill="${color}" /><path d="M 25 34 l -14 18 M 31 34 l -3 21 M 37 34 l 13 18" stroke="${outline}" stroke-width="7" /><path d="M 23 14 l -10 -9 M 39 14 l 11 -8" stroke="${accent}" stroke-width="5" /><rect x="27" y="22" width="4" height="5" fill="${light}" /><rect x="34" y="22" width="4" height="5" fill="${light}" />`,
    flask: `<path d="M 24 6 h 16 M 27 7 v 17 l -16 25 h 42 l -16 -25 v -17" fill="${color}" stroke="${outline}" stroke-width="5" /><path d="M 18 42 h 28" stroke="${accent}" stroke-width="7" /><rect x="24" y="36" width="5" height="5" fill="${light}" />`,
    golem: `<rect x="12" y="17" width="42" height="31" fill="${outline}" /><rect x="18" y="9" width="30" height="38" fill="${color}" /><rect x="23" y="20" width="6" height="6" fill="${light}" /><rect x="37" y="20" width="6" height="6" fill="${light}" /><path d="M 22 9 C 20 2 29 4 27 0 M 33 9 C 30 1 42 5 39 0" stroke="${accent}" stroke-width="4" fill="none" /><rect x="6" y="25" width="12" height="9" fill="${outline}" /><rect x="48" y="25" width="12" height="9" fill="${outline}" /><rect x="20" y="48" width="10" height="10" fill="${outline}" /><rect x="36" y="48" width="10" height="10" fill="${outline}" />`,
    leaf: `<path d="M 7 38 C 10 10 35 3 58 8 C 55 34 42 55 17 55 Z" fill="${outline}" /><path d="M 13 38 C 16 16 36 9 51 12 C 47 33 37 48 20 49 Z" fill="${color}" /><path d="M 14 48 L 47 17" stroke="${accent}" stroke-width="5" /><rect x="25" y="29" width="5" height="6" fill="${light}" /><rect x="37" y="22" width="5" height="6" fill="${light}" />`,
    crab: `<rect x="14" y="20" width="38" height="27" fill="${outline}" /><rect x="19" y="17" width="28" height="26" fill="${color}" /><rect x="21" y="11" width="7" height="10" fill="${outline}" /><rect x="38" y="11" width="7" height="10" fill="${outline}" /><rect x="22" y="13" width="4" height="5" fill="${light}" /><rect x="39" y="13" width="4" height="5" fill="${light}" /><path d="M 14 26 h -9 v -8 h 7 M 52 26 h 9 v -8 h -7" fill="none" stroke="${outline}" stroke-width="6" /><path d="M 20 45 l -10 10 M 30 45 l -3 12 M 44 45 l 10 10 M 36 45 l 3 12" stroke="${outline}" stroke-width="5" />`,
    fin: `<path d="M 7 33 C 17 10 43 8 57 28 C 45 47 24 52 7 33 Z" fill="${outline}" /><path d="M 13 32 C 22 16 42 15 51 28 C 42 41 27 45 13 32 Z" fill="${color}" /><path d="M 50 27 l 12 -13 v 25 z" fill="${accent}" stroke="${outline}" stroke-width="4" /><rect x="24" y="25" width="5" height="5" fill="${light}" /><rect x="26" y="26" width="2" height="2" fill="${outline}" />`,
    knight: `<path d="M 19 12 h 28 v 32 h -28 z" fill="${outline}" /><path d="M 24 16 h 18 v 24 h -18 z" fill="${color}" /><path d="M 20 13 l 11 -10 l 14 10" fill="${accent}" stroke="${outline}" stroke-width="5" /><rect x="27" y="23" width="13" height="5" fill="${light}" /><path d="M 16 31 h -8 v 22 M 48 31 h 8 v 22" stroke="${outline}" stroke-width="6" /><rect x="20" y="44" width="10" height="13" fill="${outline}" /><rect x="36" y="44" width="10" height="13" fill="${outline}" />`,
    core: `<circle cx="32" cy="31" r="27" fill="${outline}" /><circle cx="32" cy="31" r="18" fill="${color}" /><rect x="27" y="11" width="10" height="40" fill="${accent}" /><rect x="12" y="26" width="40" height="10" fill="${accent}" /><rect x="27" y="26" width="10" height="10" fill="${light}" />`,
    gear: `<path d="M 27 3 h 10 l 3 9 l 8 -5 l 7 7 l -5 8 l 9 3 v 10 l -9 3 l 5 8 l -7 7 l -8 -5 l -3 9 h -10 l -3 -9 l -8 5 l -7 -7 l 5 -8 l -9 -3 v -10 l 9 -3 l -5 -8 l 7 -7 l 8 5 z" fill="${outline}" /><circle cx="32" cy="31" r="18" fill="${color}" /><circle cx="32" cy="31" r="7" fill="${accent}" /><rect x="29" y="28" width="6" height="6" fill="${light}" />`,
    gem: `<path d="M 15 9 h 34 l 12 18 l -29 32 l -29 -32 z" fill="${outline}" /><path d="M 18 14 h 28 l 9 13 l -23 25 l -23 -25 z" fill="${color}" /><path d="M 18 14 l 14 38 l 14 -38 M 9 27 h 46" fill="none" stroke="${accent}" stroke-width="4" />`,
    bird: `<path d="M 7 35 C 15 9 38 6 57 15 C 48 20 46 25 55 31 C 43 48 24 54 7 35 Z" fill="${outline}" /><path d="M 13 34 C 20 15 38 12 50 16 C 41 23 42 30 49 32 C 38 43 26 47 13 34 Z" fill="${color}" /><path d="M 10 33 l -8 -8 l 14 1" fill="${accent}" stroke="${outline}" stroke-width="4" /><rect x="35" y="21" width="5" height="5" fill="${light}" /><rect x="37" y="22" width="2" height="2" fill="${outline}" />`,
    moon: `<path d="M 46 6 C 20 5 8 23 14 42 C 21 59 43 60 56 45 C 38 48 29 35 32 23 C 34 15 39 10 46 6 Z" fill="${outline}" /><path d="M 42 12 C 23 13 16 26 20 39 C 25 50 39 51 48 44 C 35 42 28 33 31 23 C 33 17 36 14 42 12 Z" fill="${color}" /><rect x="25" y="29" width="5" height="5" fill="${light}" />`,
    ghost: `<path d="M 13 22 C 13 5 51 5 51 22 v 34 l -10 -8 l -9 8 l -9 -8 l -10 8 z" fill="${outline}" /><path d="M 18 22 C 18 11 46 11 46 22 v 24 l -6 -5 l -8 6 l -8 -6 l -6 5 z" fill="${color}" /><rect x="23" y="25" width="6" height="8" fill="${light}" /><rect x="37" y="25" width="6" height="8" fill="${light}" />`,
    whale: `<path d="M 7 30 C 15 13 42 12 54 25 l 8 -8 v 20 l -8 -7 C 47 47 20 49 7 30 Z" fill="${outline}" /><path d="M 13 29 C 20 18 41 18 49 26 C 45 39 23 42 13 29 Z" fill="${color}" /><rect x="19" y="17" width="7" height="7" fill="${accent}" /><rect x="27" y="15" width="7" height="9" fill="${accent}" /><rect x="35" y="18" width="7" height="6" fill="${accent}" /><rect x="20" y="25" width="4" height="4" fill="${light}" />`,
    mantis: `<rect x="22" y="12" width="22" height="37" fill="${outline}" /><rect x="26" y="16" width="14" height="29" fill="${color}" /><path d="M 24 20 l -16 -10 M 42 20 l 16 -10 M 24 31 l -18 15 M 42 31 l 18 15" stroke="${outline}" stroke-width="6" /><rect x="26" y="8" width="5" height="8" fill="${accent}" /><rect x="36" y="8" width="5" height="8" fill="${accent}" /><rect x="28" y="22" width="4" height="5" fill="${light}" /><rect x="36" y="22" width="4" height="5" fill="${light}" />`,
  }[enemy.sprite] ?? '';

  return `<g>${base}<text x="32" y="39" fill="${outline}" font-size="${symbol.length > 2 ? 7 : 10}" font-weight="900" text-anchor="middle">${symbol}</text></g>`;
}

function opacityTimeline(start, end, duration, fade = 0.2) {
  const safeStart = clamp(start, 0, duration);
  const safeEnd = clamp(end, safeStart, duration);
  const keyTimes = monotonicKeyTimes([
    0,
    clamp((safeStart - fade) / duration, 0, 1),
    clamp(safeStart / duration, 0, 1),
    clamp(safeEnd / duration, 0, 1),
    clamp((safeEnd + fade) / duration, 0, 1),
    1,
  ]);
  return {
    values: '0;0;1;1;0;0',
    keyTimes,
  };
}

function shakeTimeline(moment, duration) {
  const points = [
    [0, '0 0'],
    [(moment - 0.15) / duration, '0 0'],
    [moment / duration, '-5 0'],
    [(moment + 0.08) / duration, '5 0'],
    [(moment + 0.16) / duration, '-4 0'],
    [(moment + 0.24) / duration, '4 0'],
    [(moment + 0.34) / duration, '0 0'],
    [1, '0 0'],
  ];
  return {
    keyTimes: monotonicKeyTimes(points.map(([time]) => time)),
    values: points.map(([, value]) => value).join(';'),
  };
}

function buildTechnologyLegend(adventure, theme) {
  const top = adventure.dominantTechnologies.length
    ? adventure.dominantTechnologies.slice(0, 4)
    : adventure.encounters.map((encounter) => ({ name: encounter.technology, commits: encounter.contributionCount }));
  return top.map((item, index) => {
    const technology = technologyDefinition(item.name);
    const x = 530 + index * 96;
    return `<g transform="translate(${x} 345)">
      <rect width="10" height="10" fill="${technology.color}" stroke="${theme.frame}" />
      <text x="15" y="9" fill="${theme.text}" font-size="8" font-weight="700">${escapeXml(truncateText(item.name, 9))}</text>
      <text x="15" y="23" fill="${theme.muted}" font-size="7">${formatNumber(item.commits ?? 0)} commits</text>
    </g>`;
  }).join('');
}

function buildMonthLabels(weeks, gridX, columnStep) {
  const monthNames = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
  const labels = [];
  let previousMonth = null;
  weeks.forEach((week, index) => {
    const date = parseDate(week.contributionDays[0].date);
    const month = date.getUTCMonth();
    if (month !== previousMonth) {
      labels.push({ x: gridX + index * columnStep, text: monthNames[month] });
      previousMonth = month;
    }
  });
  return labels;
}

function createDemoAdventure(login) {
  const today = new Date(Date.UTC(2026, 7, 17));
  const lastSaturday = addDays(today, 6 - today.getUTCDay());
  const firstSunday = addDays(lastSaturday, -(53 * 7 - 1));
  const random = mulberry32(hashString(`${login}:rpg-demo`));
  const technologies = [
    technologyDefinition('Laravel'),
    technologyDefinition('JavaScript'),
    technologyDefinition('TypeScript'),
    technologyDefinition('React'),
    technologyDefinition('PHP'),
    technologyDefinition('MySQL'),
    technologyDefinition('Docker'),
    technologyDefinition('Python'),
  ];
  const days = [];

  for (let index = 0; index < 53 * 7; index += 1) {
    const date = addDays(firstSunday, index);
    const week = Math.floor(index / 7);
    const weekday = index % 7;
    const wave = (Math.sin(week / 3.1) + 1) / 2;
    const activeProbability = 0.24 + wave * 0.32 + (weekday > 0 && weekday < 6 ? 0.1 : -0.06);
    const active = random() < activeProbability;
    const level = active ? clamp(1 + Math.floor(random() * 4.8), 1, 4) : 0;
    const definition = technologies[Math.floor(random() * technologies.length)];
    days.push({
      date: formatDate(date),
      level,
      contributionCount: level === 0 ? 0 : level + Math.floor(random() * (level * 4 + 1)),
      ...definition,
      repository: level === 0 ? undefined : `F-Keller/demo-${definition.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    });
  }

  const calendar = normalizeCalendar({ days });
  const flat = calendar.weeks.flatMap((week) => week.contributionDays).map((day) => {
    const sourceDay = days.find((candidate) => candidate.date === day.date);
    return sourceDay ? { ...day, ...sourceDay } : day;
  });
  const score = new Map();
  for (const day of flat) {
    if (!day.name || day.contributionCount === 0) continue;
    score.set(day.name, (score.get(day.name) ?? 0) + day.contributionCount);
  }
  const dominantTechnologies = [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, commits]) => ({ name, commits }));
  const encounterCandidates = flat.filter((day) => ['Laravel', 'JavaScript'].includes(day.name) && day.contributionCount > 0);
  const encounters = ['Laravel', 'JavaScript'].map((technology, index) => {
    const day = encounterCandidates.find((candidate) => candidate.name === technology)
      ?? flat.find((candidate) => candidate.contributionCount > 0)
      ?? flat[0];
    const definition = technologyDefinition(technology);
    return {
      ...day,
      ...definition,
      technology,
      creature: definition.creature,
      repository: day.repository ?? `F-Keller/demo-${index + 1}`,
    };
  });

  return {
    ...calendar,
    source: 'demo',
    daysWithTechnology: flat,
    encounters,
    dominantTechnologies,
    seed: `${login}:demo-rpg`,
  };
}

function normalizeCalendar({ days, totalContributions }) {
  const byDate = new Map(
    days
      .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date))
      .map((day) => [day.date, {
        ...day,
        date: day.date,
        level: clamp(Number(day.level) || 0, 0, 4),
        contributionCount: Math.max(0, Number(day.contributionCount) || 0),
      }]),
  );
  const sortedDates = [...byDate.keys()].sort();
  if (sortedDates.length === 0) throw new Error('calendário sem datas');
  const minDate = parseDate(sortedDates[0]);
  const maxDate = parseDate(sortedDates.at(-1));
  const gridStart = addDays(minDate, -minDate.getUTCDay());
  const gridEnd = addDays(maxDate, 6 - maxDate.getUTCDay());
  const rawWeeks = [];

  for (let weekStart = gridStart; weekStart <= gridEnd; weekStart = addDays(weekStart, 7)) {
    const contributionDays = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const current = addDays(weekStart, weekday);
      const date = formatDate(current);
      contributionDays.push(byDate.get(date) ?? {
        date,
        level: 0,
        contributionCount: 0,
      });
    }
    rawWeeks.push({ contributionDays });
  }

  const weeks = rawWeeks.length > 53 ? rawWeeks.slice(-53) : rawWeeks;
  const flatDays = weeks.flatMap((week) => week.contributionDays);
  const activeDays = flatDays.filter((day) => day.contributionCount > 0).length;
  const calculatedTotal = flatDays.reduce((sum, day) => sum + day.contributionCount, 0);

  return {
    weeks,
    activeDays,
    totalContributions: Number.isFinite(totalContributions)
      ? totalContributions
      : calculatedTotal,
  };
}

function contributionLevelToNumber(level) {
  return {
    NONE: 0,
    FIRST_QUARTILE: 1,
    SECOND_QUARTILE: 2,
    THIRD_QUARTILE: 3,
    FOURTH_QUARTILE: 4,
  }[level] ?? 0;
}

function getHtmlAttribute(tag, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = tag.match(new RegExp(`\\b${escapedName}=(?:"([^"]*)"|'([^']*)')`, 'i'));
  return match?.[1] ?? match?.[2];
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"');
}

function estimatedCountFromLevel(level) {
  return [0, 1, 3, 6, 10][level] ?? 0;
}

function sanitizeCreatureName(value) {
  return String(value ?? 'CODE')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, 8) || 'CODE';
}

function truncateText(value, maxLength) {
  const text = String(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function monotonicKeyTimes(values) {
  const output = [];
  let previous = 0;
  values.forEach((raw, index) => {
    let value = clamp(Number(raw) || 0, 0, 1);
    if (index > 0 && value <= previous) value = Math.min(1, previous + 0.0001);
    output.push(value);
    previous = value;
  });
  output[0] = 0;
  output[output.length - 1] = 1;
  return output.map((value) => round(value, 4)).join(';');
}

function parseDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date, amount) {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + amount);
  return copy;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function formatDatePt(value) {
  const date = parseDate(value);
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getUTCFullYear()}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat('pt-BR').format(Number(value) || 0);
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  return function random() {
    let value = seed += 0x6d2b79f5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, precision = 2) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
