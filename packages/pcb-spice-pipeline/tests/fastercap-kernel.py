"""Check the executed triangle kernel against a 70-digit Duffy integral.

The reference subdivides about the observation point and analytically
integrates each radial coordinate. Decimal evaluates the remaining original
logarithm without cancellation; it does not use the patched asinh expression.
"""
import json
import subprocess
import sys
from decimal import Decimal, localcontext
from pathlib import Path
from tempfile import TemporaryDirectory


def dot(a, b):
    return sum(x*y for x, y in zip(a, b))


def cross(a, b):
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]


def norm(a):
    return dot(a, a).sqrt()


def reference(vertices):
    with localcontext() as precision:
        precision.prec = 70
        v = [[Decimal(str(x)) for x in p] for p in vertices]
        center = [sum(p[k] for p in v)/3 for k in range(3)]
        relative = [[p[k]-center[k] for k in range(3)] for p in v]
        integral = Decimal(0)
        for a, b in zip(relative, relative[1:]+relative[:1]):
            edge = [y-x for x, y in zip(a, b)]
            length = norm(edge)
            u0 = dot(a, edge)/length
            u1 = u0+length
            height2 = dot(a, a)-u0*u0
            primitive = ((u1+(u1*u1+height2).sqrt())/(u0+(u0*u0+height2).sqrt())).ln()/length
            integral += norm(cross(a, b))*primitive
        area = norm(cross([v[1][k]-v[0][k] for k in range(3)], [v[2][k]-v[0][k] for k in range(3)]))/2
        return float(integral/area)


def main(source):
    source = source.resolve()
    text = (source/'FasterCap/Solver/Potential.cpp').read_text()
    signature = 'double CPotential::PotentialOpt(C3DVector r, C3DVector_float vertexes[3], bool divideByArea)'
    body = text[text.index(signature):text.index('double CPotential::PotentialOpt(C3DVector r, CAutoPanel')]
    body = body.replace('CPotential::PotentialOpt', 'potential')
    fixtures = [
        [[0, 0, 0], [.001, 0, 0], [0, .001, 0]],
        [[-.0116001, -.02892, -.000035], [-.0116001, -.02758, -.000035], [-.0116, -.02785, -.000035]],
        [[.02, -.03, .001], [.020001, -.03, .001], [.02, -.029999998, .001]],
        [[.01, .02, .03], [.0102, .0203, .0304], [.0104, .0198, .0302]],
    ]
    with TemporaryDirectory(prefix='cap-kernel-') as folder:
        path = Path(folder)
        code = f'#include <cassert>\n#define MS_VS\n#define ASSERT assert\n#include "{source}/Geometry/Vector3D.h"\n#include <cstdio>\n#include <cstdlib>\n#define _ASSERT assert\n#define POTENTIAL_GEO_EPS 1e-6\n'+body+'''
int main(int argc,char **argv) {
  C3DVector_float vertices[3]; int i,k;
  if(argc!=10)return 1;
  for(i=0;i<3;i++)for(k=0;k<3;k++)vertices[i][k]=strtod(argv[1+3*i+k],0);
  C3DVector center=(vertices[0]+vertices[1]+vertices[2])/3.0;
  printf("%.17g\\n",potential(center,vertices,true));return 0;
}
'''
        (path/'kernel.cpp').write_text(code)
        compiled = subprocess.run(['c++', '-O2', str(path/'kernel.cpp'), '-o', str(path/'kernel')], capture_output=True, text=True)
        if compiled.returncode:
            raise RuntimeError(compiled.stderr)
        errors = []
        for vertices in fixtures:
            actual = float(subprocess.check_output([str(path/'kernel'), *[str(x) for p in vertices for x in p]], text=True))
            expected = reference(vertices)
            error = abs(actual/expected-1)
            assert error < 2e-7, (actual, expected, error)
            errors.append(error)
        print(json.dumps({'reference': '70-digit Duffy radial integral', 'relativeErrors': errors}))


if __name__ == '__main__':
    main(Path(sys.argv[1]))
