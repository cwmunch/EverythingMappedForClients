// Runs before the form's own script and keeps one thing working even when the form cannot start: the
// button that removes the data the form saved in this browser. It is plain old JavaScript on purpose.
(function () {
  var failed = document.getElementById('emfc-failed');
  var key = '';
  try {
    key = JSON.parse(document.getElementById('emfc-config').textContent).storageKey;
  } catch (error) {
    key = '';
  }

  // The key of an earlier version (it was never published; this is tidiness) goes with the current one.
  var names = ['', '.broken'];

  function discard() {
    try {
      if (key) {
        for (var index = 0; index < names.length; index += 1) window.localStorage.removeItem(key + names[index]);
        window.localStorage.removeItem('emfc.form.v1');
      }
    } catch (error) {
      // There is no storage, so there is nothing to remove.
    }
    window.location.reload();
  }

  var buttons = document.getElementsByClassName('emfc-discard');
  for (var index = 0; index < buttons.length; index += 1) buttons[index].addEventListener('click', discard);

  window.addEventListener('load', function () {
    if (failed && !(window.__emfc && window.__emfc.app)) failed.hidden = false;
  });
})();
