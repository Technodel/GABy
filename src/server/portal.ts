import { Router, Request, Response } from 'express';

const router = Router();

// Serve the Visual Stakeholder Portal script
router.get('/portal.js', (req: Request, res: Response) => {
  const uid = req.query.ticket_uid;
  if (!uid) {
    res.status(400).send('console.error("[SUNy Portal] Missing ticket_uid query parameter");');
    return;
  }

  // The base URL of the SUNy server
  const sunyBaseUrl = `${req.protocol}://${req.get('host')}`;

  const script = `
(function() {
  const uid = '${uid}';
  const sunyBaseUrl = '${sunyBaseUrl}';

  // Prevent multiple injections
  if (window.__sunyPortalLoaded) return;
  window.__sunyPortalLoaded = true;

  // Load UI styles
  const style = document.createElement('style');
  style.innerHTML = \`
    #suny-portal-fab {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: linear-gradient(135deg, #FF9E00, #FFB833);
      box-shadow: 0 4px 12px rgba(255, 158, 0, 0.4);
      cursor: pointer;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s;
      border: none;
    }
    #suny-portal-fab:hover { transform: scale(1.05); }
    #suny-portal-fab svg { width: 24px; height: 24px; fill: none; stroke: #000; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    
    #suny-portal-dialog {
      position: fixed;
      bottom: 90px;
      right: 24px;
      width: 320px;
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
      z-index: 2147483647;
      font-family: system-ui, -apple-system, sans-serif;
      display: none;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid #e5e7eb;
    }
    
    .suny-portal-header {
      background: #f9fafb;
      padding: 12px 16px;
      border-bottom: 1px solid #e5e7eb;
      font-weight: 600;
      font-size: 14px;
      color: #111827;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .suny-portal-body { padding: 16px; }
    
    .suny-portal-btn {
      background: #111827;
      color: #fff;
      border: none;
      padding: 8px 12px;
      border-radius: 6px;
      font-weight: 500;
      cursor: pointer;
      width: 100%;
      margin-bottom: 8px;
    }
    .suny-portal-btn.secondary { background: #f3f4f6; color: #374151; }
    
    .suny-portal-highlight {
      outline: 3px solid #FF9E00 !important;
      outline-offset: -3px !important;
      cursor: crosshair !important;
      background-color: rgba(255, 158, 0, 0.1) !important;
    }

    #suny-portal-feedback-form { display: none; }
    #suny-portal-textarea {
      width: 100%;
      height: 80px;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      padding: 8px;
      margin-bottom: 8px;
      box-sizing: border-box;
      resize: vertical;
      font-family: inherit;
    }
  \`;
  document.head.appendChild(style);

  // Inject UI
  const fab = document.createElement('button');
  fab.id = 'suny-portal-fab';
  fab.innerHTML = '<svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>';
  document.body.appendChild(fab);

  const dialog = document.createElement('div');
  dialog.id = 'suny-portal-dialog';
  dialog.innerHTML = \`
    <div class="suny-portal-header">
      <span>SUNy Stakeholder Portal</span>
      <button id="suny-portal-close" style="background:none;border:none;cursor:pointer;font-size:16px;">&times;</button>
    </div>
    <div class="suny-portal-body">
      <div id="suny-portal-main">
        <p style="margin: 0 0 16px; font-size: 13px; color: #4b5563;">Click 'Select Element' to highlight any part of this page, then tell SUNy what you want changed.</p>
        <button id="suny-portal-start-inspect" class="suny-portal-btn">Select Element on Page</button>
      </div>
      <div id="suny-portal-feedback-form">
        <div style="font-size: 12px; color: #6b7280; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" id="suny-portal-target-info"></div>
        <textarea id="suny-portal-textarea" placeholder="E.g., Make this button larger and red..."></textarea>
        <button id="suny-portal-submit" class="suny-portal-btn">Send to Developer</button>
        <button id="suny-portal-cancel" class="suny-portal-btn secondary">Cancel</button>
      </div>
    </div>
  \`;
  document.body.appendChild(dialog);

  // State
  let inspecting = false;
  let selectedElement = null;
  let hoveredElement = null;

  // DOM Events
  fab.addEventListener('click', () => {
    dialog.style.display = dialog.style.display === 'flex' ? 'none' : 'flex';
  });

  document.getElementById('suny-portal-close').addEventListener('click', () => {
    dialog.style.display = 'none';
    stopInspect();
  });

  document.getElementById('suny-portal-start-inspect').addEventListener('click', () => {
    inspecting = true;
    dialog.style.display = 'none';
    document.body.style.cursor = 'crosshair';
  });

  document.getElementById('suny-portal-cancel').addEventListener('click', () => {
    stopInspect();
    showMain();
  });

  document.getElementById('suny-portal-submit').addEventListener('click', async () => {
    const text = document.getElementById('suny-portal-textarea').value;
    if (!text.trim()) return;

    const btn = document.getElementById('suny-portal-submit');
    btn.innerText = 'Sending...';
    btn.disabled = true;

    // Build payload
    const payload = {
      message: text,
      visualContext: {
        url: window.location.href,
        tagName: selectedElement?.tagName,
        id: selectedElement?.id,
        className: selectedElement?.className,
        innerText: selectedElement?.innerText?.slice(0, 200),
        xpath: getXPath(selectedElement)
      }
    };

    try {
      await fetch(\`\${sunyBaseUrl}/api/client-ticket/\${uid}/visual-message\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      alert('Feedback sent! SUNy is working on it.');
      stopInspect();
      showMain();
      dialog.style.display = 'none';
      document.getElementById('suny-portal-textarea').value = '';
    } catch (e) {
      alert('Failed to send feedback.');
    }
    btn.innerText = 'Send to Developer';
    btn.disabled = false;
  });

  // Inspection logic
  document.addEventListener('mouseover', (e) => {
    if (!inspecting) return;
    if (e.target.closest('#suny-portal-dialog') || e.target.closest('#suny-portal-fab')) return;
    if (hoveredElement) hoveredElement.classList.remove('suny-portal-highlight');
    hoveredElement = e.target;
    hoveredElement.classList.add('suny-portal-highlight');
    e.stopPropagation();
  }, true);

  document.addEventListener('mouseout', (e) => {
    if (!inspecting) return;
    if (hoveredElement) {
      hoveredElement.classList.remove('suny-portal-highlight');
      hoveredElement = null;
    }
  }, true);

  document.addEventListener('click', (e) => {
    if (!inspecting) return;
    if (e.target.closest('#suny-portal-dialog') || e.target.closest('#suny-portal-fab')) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    selectedElement = e.target;
    if (hoveredElement) hoveredElement.classList.remove('suny-portal-highlight');
    inspecting = false;
    document.body.style.cursor = 'default';
    
    // Show form
    document.getElementById('suny-portal-main').style.display = 'none';
    document.getElementById('suny-portal-feedback-form').style.display = 'block';
    document.getElementById('suny-portal-target-info').innerText = \`Selected: <\${selectedElement.tagName.toLowerCase()}> \${selectedElement.className}\`;
    dialog.style.display = 'flex';
  }, true);

  function stopInspect() {
    inspecting = false;
    document.body.style.cursor = 'default';
    if (hoveredElement) {
      hoveredElement.classList.remove('suny-portal-highlight');
      hoveredElement = null;
    }
    selectedElement = null;
  }

  function showMain() {
    document.getElementById('suny-portal-main').style.display = 'block';
    document.getElementById('suny-portal-feedback-form').style.display = 'none';
  }

  function getXPath(element) {
    if (!element || element.nodeType !== 1) return '';
    if (element.id) return '//*[@id="' + element.id + '"]';
    if (element === document.body) return '/html/body';

    let ix = 0;
    const siblings = element.parentNode ? element.parentNode.childNodes : [];
    for (let i = 0; i < siblings.length; i++) {
      const sibling = siblings[i];
      if (sibling === element) {
        return getXPath(element.parentNode) + '/' + element.tagName.toLowerCase() + '[' + (ix + 1) + ']';
      }
      if (sibling.nodeType === 1 && sibling.tagName === element.tagName) ix++;
    }
    return '';
  }
})();
  \`;

  res.setHeader('Content-Type', 'application/javascript');
  res.send(script);
});

export default router;
