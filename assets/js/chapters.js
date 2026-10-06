(() => {
  'use strict';
  if (typeof document === 'undefined') return;

  function initQuiz() {
    const quiz = document.getElementById('coupleQuiz');
    if (!quiz || quiz.dataset.quizEnhanced === 'true') return;
    const progress = document.getElementById('quizProgress');
    const feedback = document.getElementById('quizFeedback');
    const controls = document.getElementById('quizControls');
    const checkButton = document.getElementById('quizCheck');
    const nextButton = document.getElementById('quizNext');
    const result = document.getElementById('quizResult');
    const resultTitle = document.getElementById('quizResultTitle');
    const resultText = document.getElementById('quizResultText');
    const restartButton = document.getElementById('quizRestart');
    if (![progress, feedback, controls, checkButton, nextButton, result,
      resultTitle, resultText, restartButton].every(Boolean)) return;

    const questions = [...quiz.querySelectorAll('.quiz-question')].map(article => {
      const radios = [...article.querySelectorAll('input[type="radio"]')];
      const correct = radios.find(radio => radio.value === article.dataset.answer);
      return { article, radios, correct, note: article.dataset.note?.trim() || '' };
    });
    // Keep the readable answer details intact if the interactive markup is incomplete.
    if (!questions.length || questions.some(question => !question.radios.length || !question.correct)) return;

    let index = 0;
    let score = 0;
    let answered = false;
    const nextText = nextButton.textContent;
    const checkText = checkButton.textContent;
    quiz.dataset.quizEnhanced = 'true';
    quiz.classList.add('is-enhanced');
    feedback.setAttribute('role', 'status');
    feedback.setAttribute('aria-live', 'polite');
    feedback.setAttribute('aria-atomic', 'true');
    nextButton.setAttribute('aria-describedby', feedback.id);
    questions.forEach(question => {
      question.article.querySelectorAll('details.quiz-answer').forEach(answer => { answer.hidden = true; });
    });

    function labelFor(question, radio) {
      return radio.closest('label') || [...question.article.querySelectorAll('label')]
        .find(label => radio.id && label.htmlFor === radio.id);
    }
    function labelText(question, radio) {
      return (labelFor(question, radio)?.textContent || radio.value).replace(/\s+/g, ' ').trim();
    }
    function focusQuestion() {
      const article = questions[index].article;
      const destination = article.querySelector('legend') || article;
      destination.setAttribute('tabindex', '-1');
      // Native focus scrolls only enough to reveal the question, without animation.
      destination.focus();
    }
    function showQuestion(moveFocus = false) {
      questions.forEach((question, position) => { question.article.hidden = position !== index; });
      progress.hidden = false;
      progress.textContent = `Pergunta ${index + 1} de ${questions.length}`;
      feedback.hidden = true;
      feedback.textContent = '';
      feedback.classList.remove('is-correct', 'is-incorrect');
      controls.hidden = false;
      checkButton.hidden = false;
      checkButton.disabled = true;
      checkButton.textContent = checkText;
      nextButton.hidden = true;
      nextButton.textContent = index === questions.length - 1 ? 'Ver o resultado ♥' : nextText;
      result.hidden = true;
      answered = false;
      if (moveFocus) focusQuestion();
    }
    function reset(moveFocus = false) {
      index = 0;
      score = 0;
      questions.forEach(question => {
        question.article.classList.remove('is-answered');
        question.radios.forEach(radio => {
          radio.checked = false;
          radio.disabled = false;
          labelFor(question, radio)?.classList.remove('is-correct', 'is-incorrect');
        });
      });
      resultTitle.textContent = '';
      resultText.textContent = '';
      showQuestion(moveFocus);
    }
    function showResult() {
      questions.forEach(question => { question.article.hidden = true; });
      controls.hidden = true;
      feedback.hidden = true;
      feedback.textContent = '';
      progress.textContent = 'As nossas lembranças estão guardadas aqui. ♥';
      resultTitle.textContent = score === questions.length
        ? 'Tá vendo? Você lembra de tudo. ♥' : 'Deixa que eu te lembro, amor. ♥';
      const affection = score === questions.length
        ? 'Eu gosto tanto de saber que essas coisas também ficaram com você.'
        : 'Se escapar alguma coisa, a gente volta aqui e lembra junto. Ainda tem muita história nossa pela frente.';
      resultText.textContent = `Você acertou ${score} de ${questions.length}. ${affection}`;
      result.hidden = false;
      resultTitle.setAttribute('tabindex', '-1');
      resultTitle.focus();
    }

    quiz.addEventListener('change', event => {
      if (answered || !questions[index].radios.includes(event.target)) return;
      checkButton.disabled = !questions[index].radios.some(radio => radio.checked);
    });
    checkButton.addEventListener('click', () => {
      if (answered) return;
      const question = questions[index];
      const selected = question.radios.find(radio => radio.checked);
      if (!selected) return;
      answered = true;
      const correct = selected === question.correct;
      if (correct) score += 1;
      question.article.classList.add('is-answered');
      question.radios.forEach(radio => { radio.disabled = true; });
      labelFor(question, question.correct)?.classList.add('is-correct');
      if (!correct) labelFor(question, selected)?.classList.add('is-incorrect');
      feedback.classList.toggle('is-correct', correct);
      feedback.classList.toggle('is-incorrect', !correct);
      feedback.textContent = correct ? `Acertou, meu amor. ♥ ${question.note}`
        : `Quase, meu amor. A resposta é “${labelText(question, question.correct)}”. ${question.note}`;
      feedback.hidden = false;
      checkButton.disabled = true;
      nextButton.hidden = false;
      nextButton.focus({ preventScroll: true });
    });
    nextButton.addEventListener('click', () => {
      if (!answered) return;
      if (index === questions.length - 1) showResult();
      else { index += 1; showQuestion(true); }
    });
    restartButton.addEventListener('click', () => reset(true));
    reset();
  }

  function initWishes() {
    const inputs = [...document.querySelectorAll('input[type="checkbox"][data-wish-id]')]
      .filter(input => input.dataset.wishId.trim());
    if (!inputs.length || inputs.every(input => input.dataset.wishEnhanced === 'true')) return;
    const status = document.getElementById('wishStatus');
    const key = 'surprise:wishes:v1';
    const validIds = new Set(inputs.map(input => input.dataset.wishId));
    const selected = new Set();
    function say(message) { if (status) status.textContent = message; }
    if (status) {
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.setAttribute('aria-atomic', 'true');
    }
    let stored = null;
    let readable = true;
    try { stored = window.localStorage.getItem(key); }
    catch {
      readable = false;
      say('Não consegui acessar as escolhas salvas neste navegador. Você ainda pode marcar seus planos por aqui.');
    }
    if (readable && stored !== null) {
      try {
        const parsed = JSON.parse(stored);
        if (!Array.isArray(parsed)) throw new Error('Invalid saved wishes');
        parsed.forEach(id => { if (typeof id === 'string' && validIds.has(id)) selected.add(id); });
        say(selected.size ? 'Seus planos estão guardados só neste navegador. ♥'
          : 'As suas escolhas ficam salvas só neste navegador.');
      } catch {
        say('As escolhas salvas neste navegador não puderam ser recuperadas. Você pode escolher seus planos de novo.');
      }
    } else if (readable) say('As suas escolhas ficam salvas só neste navegador.');

    inputs.forEach(input => {
      input.checked = selected.has(input.dataset.wishId);
      if (input.dataset.wishEnhanced === 'true') return;
      input.dataset.wishEnhanced = 'true';
      input.addEventListener('change', () => {
        const id = input.dataset.wishId;
        // Duplicate controls for the same plan should agree before saving.
        inputs.forEach(other => { if (other.dataset.wishId === id) other.checked = input.checked; });
        const favorites = [...new Set(inputs.filter(other => other.checked)
          .map(other => other.dataset.wishId).filter(wishId => validIds.has(wishId)))];
        try {
          window.localStorage.setItem(key, JSON.stringify(favorites));
          say('Escolhas salvas só neste navegador. ♥');
        } catch {
          say('Não consegui salvar neste navegador. Seus planos continuam marcados enquanto esta página estiver aberta.');
        }
      });
    });
  }

  initQuiz();
  initWishes();
})();
