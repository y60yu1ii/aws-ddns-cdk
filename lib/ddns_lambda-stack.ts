import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as path from "path";
import { Construct } from "constructs";

export class DdnsLambdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here

    // enter your hosted zone name here
    const route53Name: string = "fishare.de";

    const route53Zone = cdk.aws_route53.HostedZone.fromLookup(this, "Zone", {
      domainName: route53Name,
    });

    const apiUri: string = "ddns." + route53Name;

    // create config bucket
    const configBucket = new cdk.aws_s3.Bucket(this, "configBucket", {
      bucketName: "lambda.ddns.config",
      publicReadAccess: false,
      blockPublicAccess: cdk.aws_s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Deploy config file to S3 bucket
    new cdk.aws_s3_deployment.BucketDeployment(this, "DeployWithInvalidation", {
      sources: [cdk.aws_s3_deployment.Source.asset("./src/lambda_s3_config")],
      destinationBucket: configBucket,
    });

    // create lambda function
    const ddnsLambda = new lambda.Function(this, "LambdaNodeStack", {
      functionName: "lambda_ddns",
      handler: "index.handler",
      memorySize: 1024,
      runtime: lambda.Runtime.NODEJS_16_X,
      code: lambda.Code.fromAsset(path.join(__dirname, "../src/lambda_ddns/")),
      timeout: cdk.Duration.seconds(10),
    });
    configBucket.grantRead(ddnsLambda);

    // create policy for lambda
    const lambdaPolicy = new cdk.aws_iam.PolicyStatement({
      actions: [
        "route53:ChangeResourceRecordSets",
        "route53:ListResourceRecordSets",
      ],
      resources: ["arn:aws:route53:::hostedzone/" + route53Zone.hostedZoneId],
    });

    const s3ListBucketsPolicy = new cdk.aws_iam.PolicyStatement({
      actions: ["s3:ListAllMyBuckets"],
      resources: ["arn:aws:s3:::*"],
    });

    // attach policy to lambda
    ddnsLambda.role?.attachInlinePolicy(
      new cdk.aws_iam.Policy(this, "list-buckets-policy", {
        statements: [lambdaPolicy, s3ListBucketsPolicy],
      })
    );

    const certificate = new cdk.aws_certificatemanager.Certificate(
      this,
      "Certificate",
      {
        domainName: apiUri,
        validation:
          cdk.aws_certificatemanager.CertificateValidation.fromDns(route53Zone),
      }
    );

    const restApi = new cdk.aws_apigateway.LambdaRestApi(this, "dddns-api", {
      handler: ddnsLambda,
      proxy: false,
      domainName: {
        securityPolicy: cdk.aws_apigateway.SecurityPolicy.TLS_1_2,
        domainName: apiUri,
        certificate: certificate,
        endpointType: cdk.aws_apigateway.EndpointType.REGIONAL,
      },
    });

    const methodResponse: cdk.aws_apigateway.MethodResponse = {
      statusCode: "200",
      responseModels: {
        "application/json": cdk.aws_apigateway.Model.EMPTY_MODEL,
      },
    };

    const integrationResponse: cdk.aws_apigateway.IntegrationResponse = {
      statusCode: "200",
      contentHandling: cdk.aws_apigateway.ContentHandling.CONVERT_TO_TEXT,
    };

    new cdk.aws_route53.ARecord(this, "apiDNS", {
      zone: route53Zone,
      recordName: apiUri,
      target: cdk.aws_route53.RecordTarget.fromAlias(
        new cdk.aws_route53_targets.ApiGateway(restApi)
      ),
    });

    const requestTemplate: Object = {
      execution_mode: "$input.params('mode')",
      source_ip: "$context.identity.sourceIp",
      set_hostname: "$input.params('hostname')",
      validation_hash: "$input.params('hash')",
    };

    const ddnsIntegration = new cdk.aws_apigateway.LambdaIntegration(
      ddnsLambda,
      {
        allowTestInvoke: true,
        proxy: false,
        integrationResponses: [integrationResponse],
        passthroughBehavior:
          cdk.aws_apigateway.PassthroughBehavior.WHEN_NO_TEMPLATES,
        requestTemplates: {
          "application/json": JSON.stringify(requestTemplate),
        },
      }
    );

    restApi.root.addMethod("GET", ddnsIntegration, {
      methodResponses: [methodResponse],
    });

    new cdk.CfnOutput(this, "URL", { value: apiUri + "/?mode=get" });
  }
}
