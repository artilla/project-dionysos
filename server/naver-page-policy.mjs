export const isNaverReviewsPage = path => ['/naver-reviews.html', '/naver-reviews'].includes(path);

// The standalone search page never loads the app's analytics or advertising.
export const naverPageHeaders = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
