/* Stable Neumann line integral for distant filament pairs.
 * Eight-point Gauss-Legendre quadrature on each [0,1] segment. Call only
 * when every endpoint separation exceeds four times either segment length.
 * Near-field and finite-cross-section formulas remain in FastHenry.
 */
static double fh_far_mutual(const double a[3], const double da[3],
                            const double b[3], const double db[3])
{
  static const double x[8] = {
    .019855071751231884, .10166676129318663, .2372337950418355, .4082826787521751,
    .5917173212478249, .7627662049581645, .8983332387068134, .9801449282487681
  };
  static const double w[8] = {
    .05061426814518813, .11119051722668724, .15685332293894365, .18134189168918099,
    .18134189168918099, .15685332293894365, .11119051722668724, .05061426814518813
  };
  double sum = 0, dot = 0, r[3], d2;
  int i, j, k;
  for (k = 0; k < 3; ++k) dot += da[k]*db[k];
  for (i = 0; i < 8; ++i) for (j = 0; j < 8; ++j) {
    d2 = 0;
    for (k = 0; k < 3; ++k) {
      r[k] = (a[k]-b[k]) + x[i]*da[k] - x[j]*db[k];
      d2 += r[k]*r[k];
    }
    sum += w[i]*w[j]/sqrt(d2);
  }
  return 1e-7*dot*sum;
}
