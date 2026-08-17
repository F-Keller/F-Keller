# Personalização

As principais opções ficam em `scripts/generate-rpg.mjs`.

## Frequência e duração

Procure por:

```js
const duration = 38;
const encounterTimings = [8.2, 23.4];
const battleLength = 7.4;
```

- `duration`: duração do ciclo completo.
- `encounterTimings`: segundo em que cada batalha começa.
- `battleLength`: duração de cada batalha.

## Criaturas e golpes

Procure pela função:

```js
technologyDefinition(name, preferredColor)
```

Cada tecnologia possui:

```js
{
  creature: 'LARAVAGON',
  color: '#ef3340',
  accent: '#8d111b',
  move: 'ROTA API',
  symbol: 'L',
  sprite: 'dragon'
}
```

É possível trocar nome, cores, golpe, símbolo e formato do monstro.

## Observação visual

O projeto usa arte pixelada original e uma interface própria de RPG de criaturas. Não contém sprites oficiais de Pokémon.
