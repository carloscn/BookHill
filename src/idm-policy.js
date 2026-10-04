// Identity boundaries for account migration and Drive documents. No email matching.
(function (root) {
  const policy = {
    linkedSubject(binding, sub) {
      return typeof sub === "string" && sub && binding?.sub === sub
        && typeof binding.google?.sub === "string" ? binding.google.sub : "";
    },
    acceptsDocument(document, sub, googleSub) {
      if (!document) return true;
      const owner = document.identity;
      return Boolean(googleSub && owner && (
        (owner.type === "cloud" && owner.id === googleSub) ||
        (owner.type === "idm" && owner.id === sub && owner.googleSub === googleSub)
      ));
    }
  };
  if (typeof module !== "undefined") module.exports = policy;
  else root.langLSRWIdmPolicy = policy;
})(typeof window !== "undefined" ? window : globalThis);
