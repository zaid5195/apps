// يفتح اللوحة الجانبية عند الضغط على أيقونة الإضافة
const enable = () => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.runtime.onInstalled.addListener(enable);
chrome.runtime.onStartup.addListener(enable);
enable();
