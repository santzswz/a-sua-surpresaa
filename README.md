# Sua surpresa ♥

Uma surpresa de aniversário feita de carta, fotografias e música. Site estático em português, publicado no [GitHub Pages](https://santzswz.github.io/a-sua-surpresaa/).

## A experiência

- Envelope de entrada com escolha de ouvir música ou entrar sem som.
- Carta original, desejos de aniversário, linha do tempo e contador da nossa história.
- Dez fotografias preservadas no próprio repositório; nove lembranças na galeria, com navegação por botões, teclado e deslize no celular. Cada lembrança ganhou um recado carinhoso, também visível na foto ampliada; as datas da história têm novas notas pessoais.
- Trecho de **Partilhar — Rubel** durante a leitura: continua ao abrir e navegar pelas fotos, conserva a posição ao pausar e tem transições suaves de volume. As músicas de cada foto entram apenas pelo seu player.
- Os trechos são prévias de cerca de 30 segundos; terminam sem repetição automática. Os links levam à música completa nos serviços de origem.
- Um potinho de carinho revela frases da carta original, sem repetir a anterior, e pequenos capítulos dão acesso às datas da história.
- Presente com a brincadeira dos R$ 0,20 e a revelação dos R$ 300,00. Ocultar o saldo também oculta o valor na mensagem.
- Recados secretos, foco visível, respeito à preferência por movimento reduzido e conteúdo acessível mesmo sem JavaScript.

## Estrutura

```text
index.html                 Conteúdo da surpresa
assets/css/style.css       Layout e identidade visual
assets/js/app.js           Interações e integração dos players
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

Abra `http://localhost:8000`. Só os trechos de música usam serviços externos; as fontes, as fotografias, a carta e os presentes são locais. As licenças SIL Open Font License ficam junto aos arquivos de fontes em `assets/fonts/`.

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

O áudio começa apenas por uma ação da pessoa. A trilha de fundo continua ao visitar a galeria; uma música de foto substitui a anterior com fade quando seu trecho fica pronto. Cada faixa conserva sua posição nesta visita. O fim da prévia só pode ser reiniciado pelo player, nunca por navegar pelas fotos. O áudio é pausado imediatamente quando a aba fica oculta. Os fades usam o volume nativo, conforme o suporte do navegador. No iOS, onde o volume pode ser controlado apenas pelo sistema, a troca é sequencial para evitar duas músicas tocando juntas.

O workflow de verificação executa os testes em pull requests e em alterações de `main`. A publicação continua usando a configuração existente do GitHub Pages.
