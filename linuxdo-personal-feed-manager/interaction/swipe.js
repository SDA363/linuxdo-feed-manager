(() => {
  let activeTopic = null;
  let startX = 0;
  let startY = 0;
  let tracking = false;

  function findTopic(touch) {
    const row = window.LDFCTopicParser.findTopicRow(touch.target);
    if (!row) return null;
    return window.LDFCTopicParser.extractTopic(row);
  }

  function onTouchStart(event) {
    if (event.touches.length !== 1) return;

    const touch = event.touches[0];
    activeTopic = findTopic(touch);
    if (!activeTopic) return;

    startX = touch.clientX;
    startY = touch.clientY;
    tracking = true;
    activeTopic.row.classList.remove("ldfc-swipe-left", "ldfc-swipe-right");
  }

  function onTouchMove(event) {
    if (!tracking || !activeTopic || event.touches.length !== 1) return;

    const touch = event.touches[0];
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;

    if (Math.abs(deltaX) <= Math.abs(deltaY) * 1.5) return;

    activeTopic.row.classList.toggle("ldfc-swipe-right", deltaX > 24);
    activeTopic.row.classList.toggle("ldfc-swipe-left", deltaX < -24);
  }

  function onTouchEnd(event) {
    if (!tracking || !activeTopic) return;

    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;
    const row = activeTopic.row;
    tracking = false;

    row.classList.remove("ldfc-swipe-left", "ldfc-swipe-right");

    if (Math.abs(deltaX) < 72 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.5) {
      activeTopic = null;
      return;
    }

    if (deltaX > 0) {
      window.LDFCContent.markInterested(activeTopic);
    } else {
      window.LDFCContent.markDismissed(activeTopic);
    }

    activeTopic = null;
  }

  function start() {
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: true });
    document.addEventListener("touchend", onTouchEnd);
  }

  window.LDFCSwipe = { start };
})();
