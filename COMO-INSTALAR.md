# Como instalar o mapa RPG no perfil

## 1. Crie o repositório de perfil

O nome precisa ser exatamente igual ao usuário do GitHub:

```text
F-Keller/F-Keller
```

O repositório deve ser público.

## 2. Envie os arquivos

Coloque na raiz do repositório:

```text
.github/workflows/github-rpg.yml
assets/github-rpg.svg
assets/github-rpg-dark.svg
assets/github-rpg-data.json
scripts/generate-rpg.mjs
README.md
package.json
```

## 3. Execute o workflow

Abra:

```text
Actions → Atualizar mapa RPG de contribuições → Run workflow
```

Depois da primeira execução, o workflow roda diariamente.

## 4. Permissão para gravar os SVGs

O workflow já contém:

```yaml
permissions:
  contents: write
```

Caso o push do robô seja bloqueado, acesse:

```text
Settings → Actions → General → Workflow permissions
```

Marque **Read and write permissions**.

## 5. Contribuições privadas e tecnologia predominante

O `GITHUB_TOKEN` consegue consultar dados públicos. Para o gerador identificar detalhes de repositórios privados, crie um token pessoal com o mínimo de acesso necessário e salve no repositório como:

```text
RPG_GRAPH_TOKEN
```

Caminho:

```text
Settings → Secrets and variables → Actions → New repository secret
```

Sem esse segredo, contribuições privadas continuam aparecendo no calendário quando sua configuração do GitHub permite, mas podem virar a criatura genérica `CRYPTOMON` ou usar a tecnologia pública predominante.

## Como funciona o “aleatório”

O README do GitHub não executa JavaScript. Por isso, os encontros são sorteados quando o GitHub Actions gera o SVG. A animação permanece igual durante aquele dia e recebe outra sequência na atualização seguinte.
