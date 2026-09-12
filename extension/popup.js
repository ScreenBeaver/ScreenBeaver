fetch("http://127.0.0.1:17355/health")
  .then((r) => r.json())
  .then(() => {
    const el = document.getElementById("status");
    el.textContent = "Connected to Screen Beaver desktop.";
    el.className = "ok";
  })
  .catch(() => {
    const el = document.getElementById("status");
    el.textContent = "Desktop app not running. Open Screen Beaver EXE first.";
    el.className = "bad";
  });
