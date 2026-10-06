# Sua surpresa ♥

Uma surpresa de aniversário feita de carta, fotografias e música. Site estático em português, publicado no [GitHub Pages](https://santzswz.github.io/a-sua-surpresaa/).

## A experiência

- Envelope de entrada com escolha de ouvir música ou entrar sem som.
- Carta original, desejos de aniversário, linha do tempo e contador da nossa história.
- Dez fotografias preservadas no próprio repositório; nove lembranças na galeria, com navegação por botões, teclado e deslize no celular. Cada lembrança ganhou um recado carinhoso, também visível na foto ampliada; as datas da história têm novas notas pessoais.
- **Te Amo Disgraça — Baco Exu do Blues**, inteira, no MP3 enviado ao repositório: começa no início e continua ao abrir e navegar pelas fotos, conserva a posição ao pausar e tem entrada e saída suaves. A foto ligada à mesma música compartilha esse áudio, sem reiniciar nem carregar uma prévia.
- As demais músicas das fotos entram apenas pelo seu player e usam prévias de cerca de 30 segundos. Todas as faixas terminam sem repetição automática; os links das outras músicas levam aos serviços de origem.
- Um potinho de carinho revela frases da carta original, sem repetir a anterior, e pequenos capítulos dão acesso às datas da história.
- Presente com a brincadeira dos R$ 0,20 e a revelação dos R$ 300,00. Ocultar o saldo também oculta o valor na mensagem.
- Recados secretos, foco visível, respeito à preferência por movimento reduzido e conteúdo acessível mesmo sem JavaScript.
- Quatro cartas “Abra quando…” e quatro vales de carinho abrem no próprio site, inclusive sem JavaScript. Para usar um vale, basta mostrar o recado; o site não envia mensagens nem registra um resgate.
- Quiz de cinco perguntas sobre as datas, a música e o futuro de vocês, com respostas, resultado e opção de jogar novamente. Sem JavaScript, as perguntas e respostas continuam disponíveis.
- Planos para viver juntos, incluindo o futuro pedido de casamento na Torre Eiffel. Os planos marcados como desejos ficam salvos somente neste navegador, quando o armazenamento está disponível.

## Estrutura

```text
index.html                 Conteúdo da surpresa
assets/css/style.css       Layout e identidade visual
assets/css/chapters.css    Cartas, vales, quiz e planos de viagem
assets/js/app.js           Interações e integração dos players
assets/js/chapters.js      Quiz e desejos guardados neste navegador
assets/js/audio-controller.js Continuidade, fades e estado de reprodução
assets/js/details.js       Potinho de carinho e navegação de capítulos
assets/js/date-utils.js    Cálculos de calendário no fuso UTC−03:00
assets/photos/             As dez fotografias originais
tests/                     Testes de datas e navegação no navegador
```

Não há etapa de build nem dependências para publicar. Os caminhos relativos funcionam no subdiretório do GitHub Pages.

## Ver localmente

```sh
python -m http.server 8000
```

Abra `http://localhost:8000`. O MP3 da trilha de fundo, as fontes e as fotografias são locais. Só as prévias das outras músicas usam serviços externos. As licenças SIL Open Font License ficam junto aos arquivos de fontes em `assets/fonts/`.

## Verificar alterações

Os testes de calendário usam apenas Node. Para os testes no navegador:

```sh
python -m pip install -r requirements-dev.txt
python -m playwright install chromium
node --test tests/*.test.cjs
python -m unittest discover -s tests -p 'test_*.py' -v
```

Se já houver um Chromium instalado, defina `CHROMIUM_PATH` com o caminho do executável. Os testes de interface usam um servidor local temporário e simulam falhas de serviços externos, sem depender de músicas ou fontes disponíveis na rede.

## Personalizar

O texto, as legendas e as músicas da galeria ficam em `index.html`. As datas de aniversário e início da história ficam em `assets/js/date-utils.js`; os valores do presente ficam em `assets/js/app.js`. As datas são calculadas em UTC−03:00 para que o contador permaneça consistente ao abrir o site em outro fuso.

Os controles de saldo fazem parte da brincadeira visual: o site é público, e o valor também pode ser encontrado no código. Preserve os arquivos de fotos ao editar o projeto.

O áudio começa apenas por uma ação da pessoa. O MP3 original tem aproximadamente 4min50s e é usado sem cortes ou conversão. A trilha de fundo continua ao visitar a galeria; a foto de Te Amo Disgraça usa o mesmo player. As outras músicas substituem a trilha quando a prévia fica pronta. Cada faixa conserva sua posição nesta visita e só recomeça após o fim por um toque explícito no player. O áudio é pausado imediatamente quando a aba fica oculta.

O fade do MP3 local usa Web Audio quando disponível, inclusive no iOS, com fallback para o volume nativo. O contexto de áudio só é criado ao ouvir a música. As prévias externas continuam usando o volume nativo, conforme o suporte do navegador; no iOS, a troca com essas faixas é sequencial para evitar duas músicas tocando juntas.

O workflow de verificação executa os testes em pull requests e em alterações de `main`. A publicação continua usando a configuração existente do GitHub Pages.
