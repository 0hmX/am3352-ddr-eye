/* Stable near-parallel Neumann integral. One segment is integrated exactly;
 * adaptive Gaussian quadrature integrates the other. Coordinates are metres.
 * Targets: relative2e-11 / absolute1e-12 on the positive dimensionless integral.
 * Failure is explicit after40 levels or200000 function evaluations. */
#include <math.h>
#include <float.h>
typedef struct {
 double q0[3],q1[3],t0[3],t1[3],da[3],e2[3],m,dotSlope,perpSlope,u0,zCenter,gap;
 double lo,hi;int centered,map,evaluations,status;
} fhs_context;
static double fhs_dop(double a,double b,double c,double d)
{
 double cd=c*d;
 return fma(a,b,-cd)+fma(-c,d,cd);
}
static void fhs_cross(const double a[3],const double b[3],double n[3])
{
 n[0]=fhs_dop(a[1],b[2],a[2],b[1]);
 n[1]=fhs_dop(a[2],b[0],a[0],b[2]);
 n[2]=fhs_dop(a[0],b[1],a[1],b[0]);
}
static double fhs_dot(const double a[3],const double b[3])
{
 return fma(a[0],b[0],fma(a[1],b[1],a[2]*b[2]));
}
static double fhs_norm(const double a[3])
{ return hypot(hypot(a[0],a[1]),a[2]); }
static double fhs_inner(double z0,double z1,double rho,double m)
{
 double x,h0,h1;
 if(z0<=0.0 || z1>=0.0){
   x=z0<=0.0?-z0:z1;
   h0=hypot(x,rho);h1=hypot(x+m,rho);
   if(!(x+h0>0.0))return HUGE_VAL;
   return log1p(m*(1.0+(2.0*x+m)/(h0+h1))/(x+h0));
 }
 if(!(rho>0.0))return HUGE_VAL;
 return asinh(z0/rho)+asinh(-z1/rho);
}
static double fhs_value(fhs_context *c,double t)
{
 double width=c->hi-c->lo,u,other,delta,jac,z0,z1,rho,q[3],qb[3],cross[3],phi;
 int k;
 if(++c->evaluations>200000){c->status=2;return 0.0;}
 if(c->map==1){
   delta=width*t*t;u=c->lo+delta;
   other=(1.0-c->hi)+width*(1.0-t)*(1.0+t);
   delta+=(c->lo-c->u0);jac=2.0*width*t;
 }
 else if(c->map==-1){
   delta=-width*t*t;
   u=c->lo+width*(1.0-t)*(1.0+t);other=(1.0-c->hi)-delta;
   delta+=(c->hi-c->u0);jac=2.0*width*t;
 }
 else{
   delta=width*t;u=c->lo+delta;other=(1.0-c->hi)+width*(1.0-t);
   delta+=(c->lo-c->u0);jac=width;
 }
 for(k=0;k<3;k++){
   q[k]=u<=0.5?fma(u,c->da[k],c->q0[k]):fma(-other,c->da[k],c->q1[k]);
   qb[k]=u<=0.5?fma(u,c->da[k],c->t0[k]):fma(-other,c->da[k],c->t1[k]);
 }
 z0=fhs_dot(q,c->e2);z1=fhs_dot(qb,c->e2);
 if(c->centered)rho=hypot(c->gap,c->perpSlope*delta);
 else{fhs_cross(q,c->e2,cross);rho=fhs_norm(cross);}
 phi=fhs_inner(z0,z1,rho,c->m);
 if(!isfinite(phi) || phi<0.0){c->status=3;return 0.0;}
 return jac*phi;
}
static const double fhs_x8[8]={0.019855071751231912,0.10166676129318664,0.2372337950418355,0.40828267875217505,0.59171732124782495,0.7627662049581645,0.89833323870681336,0.98014492824876809};
static const double fhs_w8[8]={0.050614268145188261,0.11119051722668723,0.15685332293894358,0.18134189168918091,0.18134189168918091,0.15685332293894358,0.11119051722668723,0.050614268145188261};
static const double fhs_x16[16]={0.0052995325041750307,0.0277124884633837,0.067184398806084178,0.12229779582249845,0.19106187779867811,0.27099161117138632,0.35919822461037054,0.45249374508118129,0.54750625491881877,0.64080177538962946,0.72900838882861363,0.80893812220132189,0.87770220417750155,0.93281560119391582,0.9722875115366163,0.99470046749582497};
static const double fhs_w16[16]={0.013576229705877027,0.031126761969323805,0.047579255841246497,0.062314485627766973,0.074797994408288326,0.08457825969750131,0.091301707522461806,0.094725305227534293,0.094725305227534293,0.091301707522461806,0.08457825969750131,0.074797994408288326,0.062314485627766973,0.047579255841246497,0.031126761969323805,0.013576229705877027};

static double fhs_gauss(fhs_context *c,double a,double b,int order)
{
 const double *x=order==8?fhs_x8:fhs_x16,*w=order==8?fhs_w8:fhs_w16;
 double sum=0.0;int i;
 for(i=0;i<order;i++)sum+=w[i]*fhs_value(c,fma(b-a,x[i],a));
 return (b-a)*sum;
}
typedef struct {double a,b,value,error;int depth;} fhs_piece;
static void fhs_piece_value(fhs_context *c,fhs_piece *p)
{
 double low=fhs_gauss(c,p->a,p->b,8),high=fhs_gauss(c,p->a,p->b,16);
 p->value=high;p->error=fabs(high-low);
}
static double fhs_adapt(fhs_context *c,double a,double b,double absolute,int unused)
{
 fhs_piece pieces[2048],left,right,old;
 double sum,error,middle;int count=1,i,worst;
 pieces[0].a=a;pieces[0].b=b;pieces[0].depth=0;
 fhs_piece_value(c,&pieces[0]);
 while(!c->status){
   sum=0.0;error=0.0;worst=0;
   for(i=0;i<count;i++){
     sum+=pieces[i].value;error+=pieces[i].error;
     if(pieces[i].error>pieces[worst].error)worst=i;
   }
   if(error<=absolute+2e-11*fabs(sum))return sum;
   old=pieces[worst];
   if(old.depth==40 || count==2048){c->status=4;return 0.0;}
   middle=(old.a+old.b)/2.0;
   left.a=old.a;left.b=middle;left.depth=old.depth+1;
   right.a=middle;right.b=old.b;right.depth=old.depth+1;
   fhs_piece_value(c,&left);fhs_piece_value(c,&right);
   pieces[worst]=left;pieces[count++]=right;
 }
 return 0.0;
}
static int fh_near_parallel_mutual(const double a0[3],const double a1[3],
 const double b0[3],const double b1[3],double *result,int *used)
{
 fhs_context c;
 double n[3],r[3],rb[3],ra[3],da[3],db[3],l,m,nn,normn,sine,ab,z0,bp[5],temp,sum=0.0,x;
 int i,j,count=2;
 *used=0;for(i=0;i<3;i++){da[i]=a1[i]-a0[i];db[i]=b1[i]-b0[i];}
 l=fhs_norm(da);m=fhs_norm(db);
 if(!(l>0.0 && m>0.0) || !isfinite(l) || !isfinite(m))return 1;
 fhs_cross(da,db,n);normn=fhs_norm(n);sine=normn/(l*m);
 if(normn==0.0 || sine>=1e-4)return 0; /* exact parallel uses closed form */
 *used=1;nn=fhs_dot(n,n);
 if(!(nn>0.0) || !isfinite(nn))return 1;
 c.m=m;c.evaluations=0;c.status=0;
 for(i=0;i<3;i++){r[i]=b0[i]-a0[i];c.q0[i]=a0[i]-b0[i];c.q1[i]=a1[i]-b0[i];c.t0[i]=a0[i]-b1[i];c.t1[i]=a1[i]-b1[i];c.da[i]=da[i];c.e2[i]=db[i]/m;}
 fhs_cross(r,db,rb);fhs_cross(r,da,ra);
 c.u0=fhs_dot(rb,n)/nn;c.zCenter=m*fhs_dot(ra,n)/nn;
 c.gap=fabs(fhs_dot(r,n))/normn;c.perpSlope=normn/m;
 ab=fhs_dot(da,db);c.dotSlope=ab/m;c.centered=c.u0>=-4.0 && c.u0<=5.0;
 z0=fhs_dot(c.q0,c.e2);bp[0]=0.0;bp[1]=1.0;
 if(c.u0>0.0 && c.u0<1.0)bp[count++]=c.u0;
 if(c.dotSlope!=0.0){
   x=-z0/c.dotSlope;if(x>0.0 && x<1.0)bp[count++]=x;
   x=(m-z0)/c.dotSlope;if(x>0.0 && x<1.0)bp[count++]=x;
 }
 for(i=0;i<count;i++)for(j=i+1;j<count;j++)if(bp[j]<bp[i]){temp=bp[i];bp[i]=bp[j];bp[j]=temp;}
 for(i=0;i<count-1;i++){
   if(bp[i+1]==bp[i])continue;
   c.lo=bp[i];c.hi=bp[i+1];
   c.map=c.lo==c.u0?1:(c.hi==c.u0?-1:0);
   sum+=fhs_adapt(&c,0.0,1.0,1e-12*(c.hi-c.lo),0);
   if(c.status)return c.status;
 }
 *result=1e-7*(ab/m)*sum;
 return isfinite(*result)?0:5;
}
