// 测试用：把 Node 进程里发往腾讯文档的 fetch 改道到本地模拟服务。
const target = process.env.TDOCS_MOCK_BASE;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const text = String(url);
  const mapped = text
    .replace('https://saas.docs.qq.com', target + '/saas')
    .replace('https://docs.qq.com', target + '/personal')
    .replace('https://cos.example.test', target + '/cos');
  return realFetch(mapped, init);
};
