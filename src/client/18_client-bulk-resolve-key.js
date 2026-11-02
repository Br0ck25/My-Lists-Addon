// The key an import row and its /api/bulk-resolve answer are matched by. The
// type is part of it: a movie and a show with the same title and year must not
// share an IMDb id. A missing type (an older server's answer) means a movie.
function bulkResolveKey(title, year, type) {
  return (String(title || '') + '|' + (year || '') + '|' + (type === 'series' ? 'series' : 'movie')).toLowerCase();
}
