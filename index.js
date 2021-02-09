const _ = require('lodash');

class CICD {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;

    this.defaultOptions = {
      baseImage: 'aws/codebuild/amazonlinux2-x86_64-standard:3.0',
      gitOwner: '',
      gitRepo: this.serverless.service.service,
      gitBranch: 'main',
      githubOAuthToken: '',
    };

    this.options = _.defaults(this.serverless.service.custom.cicd, this.defaultOptions);

    this.hooks = {
      'before:package:initialize': this.createPipeline,
    };
  }

  createPipeline = () => {
    if (this.options.excludestages?.includes(this.stage)) {
      this.serverless.cli.log(`CICD is ignored for ${this.stage} stage`);

      return;
    }

    this.serverless.cli.log('Updating CICD Resources...');

    const pipelineResources = this.generateResources();

    _.merge(this.serverless.service, { resources: { ...pipelineResources } });

    this.serverless.cli.log('CICD Resources Updated');
  };

  generateResources = () => {
    const { service } = this.serverless;
    const serviceName = service.service;
    const { stage } = this.serverless.service.custom;

    if (service.custom[this.stage]) {
      this.options.gitBranch = service.custom[this.stage].branch;
    }

    const buildEnvVars = service.custom.cicd.envVars
      ? service.custom.cicd.envVars.map(envVar => {
          const [[key, value]] = Object.entries(envVar);

          return { Name: key, Value: value };
        })
      : [];

    const role = {
      CICDRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: `${serviceName}-${stage}`,
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: {
                  Service: ['codepipeline.amazonaws.com'],
                },
                Action: ['sts:AssumeRole'],
              },
              {
                Effect: 'Allow',
                Principal: {
                  Service: ['codebuild.amazonaws.com'],
                },
                Action: ['sts:AssumeRole'],
              },
            ],
          },
          Policies: [
            {
              PolicyName: `${serviceName}-${stage}`,
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: [
                      'cloudformation:DescribeStacks',
                      'cloudformation:DescribeStackResource',
                      's3:ListBucket',
                      's3:GetObject',
                      's3:GetObjectVersion',
                      'lambda:GetFunction',
                      'sts:GetCallerIdentity',
                      's3:PutObject',
                      'cloudformation:ValidateTemplate',
                      'cloudformation:UpdateStack',
                      'cloudformation:DescribeStackEvents',
                      'cloudformation:ListStackResources',
                    ],
                    Resource: '*',
                  },
                ],
              },
            },
          ],
        },
      },
    };

    const codeBuild = {
      Build: {
        Type: 'AWS::CodeBuild::Project',
        Properties: {
          Name: `${serviceName}-${stage}`,
          ServiceRole: {
            'Fn::GetAtt': ['CICDRole', 'Arn'],
          },
          Artifacts: {
            Type: 'CODEPIPELINE',
            Name: `${serviceName}-${stage}-build`,
            Packaging: 'NONE',
          },
          Environment: {
            Type: 'LINUX_CONTAINER',
            ComputeType: 'BUILD_GENERAL1_SMALL',
            Image: `${this.options.image}`,
            EnvironmentVariables: [
              {
                Name: 'STAGE',
                Value: `${stage}`,
              },
              ...buildEnvVars,
            ],
          },
          Source: {
            Type: 'CODEPIPELINE',
          },
          TimeoutInMinutes: 60,
        },
      },
    };

    const codePipeline = {
      Pipeline: {
        Type: 'AWS::CodePipeline::Pipeline',
        Properties: {
          Name: `${serviceName}-${stage}`,
          RoleArn: {
            'Fn::GetAtt': ['CICDRole', 'Arn'],
          },
          Stages: [
            {
              Name: 'Source',
              Actions: [
                {
                  Name: 'Source',
                  ActionTypeId: {
                    Category: 'Source',
                    Owner: 'ThirdParty',
                    Version: '1',
                    Provider: 'GitHub',
                  },
                  OutputArtifacts: [{ Name: `${serviceName}` }],
                  Configuration: {
                    Owner: `${this.options.gitOwner}`,
                    Repo: `${this.options.gitRepo}`,
                    Branch: `${this.options.gitBranch}`,
                    OAuthToken: `${this.options.githubOAuthToken}`,
                  },
                  RunOrder: '1',
                },
              ],
            },
            {
              Name: 'Build',
              Actions: [
                {
                  Name: 'CodeBuild',
                  InputArtifacts: [{ Name: `${serviceName}` }],
                  ActionTypeId: {
                    Category: 'Build',
                    Owner: 'AWS',
                    Version: '1',
                    Provider: 'CodeBuild',
                  },
                  OutputArtifacts: [{ Name: `${serviceName}Build` }],
                  Configuration: {
                    ProjectName: {
                      Ref: 'Build',
                    },
                  },
                  RunOrder: '1',
                },
              ],
            },
          ],
          ArtifactStore: {
            Type: 'S3',
            Location: { Ref: 'ServerlessDeploymentBucket' },
          },
        },
      },
    };

    return {
      Resources: {
        ...role,
        ...codeBuild,
        ...codePipeline,
      },
    };
  };
}

module.exports = CICD;
