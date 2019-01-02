import {core, flags, SfdxCommand} from '@salesforce/command';
import {AnyJson} from '@salesforce/ts-types';

import * as sgp from 'sfdc-generate-package';
import {promisify} from 'util';
import {exec as childExec} from 'child_process';

const exec = promisify(childExec);

core.Messages.importMessagesDirectory(__dirname);
const messages = core.Messages.loadMessages('sfdx-rusl-plugin', 'mdapi_package_install');

export default class Install extends SfdxCommand {
  protected static requiresUsername = true;
  protected static supportsDevhubUsername = true;
  protected static requiresProject = true;

  protected static flagsConfig = {
    packagename: flags.string({
      char: 'n',
      description: messages.getMessage('packageNameFlagDescription'),
      required: true
    }),
    outputdir: flags.string({
      char: 'd',
      description: messages.getMessage('outputDirFlagDescription'),
      default: 'mdapiout'
    }),
    savesources: flags.boolean({
      char: 's',
      description: messages.getMessage('saveSourcesFlagDescription'),
      default: false
    })
  };

  public static description = messages.getMessage('commandDescription');

  public static examples = [
    `$ sfdx rusl:mdapi:package:install --targetusername myOrg@example.com --packagename myPackage`,
    `$ sfdx rusl:mdapi:package:install --targetusername myOrg --packagename myPackage --outputdir mdsource`,
    `$ sfdx rusl:mdapi:package:install --targetusername myOrg --packagename myPackage --savesources`
  ];

  public async run(): Promise<AnyJson> {
    try {
      this.ux.startSpinner('Resolve the project packages configuration');
      const config = await this.project.resolveProjectConfig();
      this.ux.stopSpinner('done');

      const packageNames = this.getPackageHierarchy(this.flags.packagename, config.packageDirectories);
      await this.convertPackages(packageNames, this.flags.outputdir);

      this.ux.startSpinner(`Generate sources package.xml`);
      await this.generatePackageXmlFile(this.flags.outputdir, this.flags.apiversion);
      this.ux.stopSpinner(`done\n`);

      this.ux.startSpinner(`Deploy the package and its dependencies`);
      await this.deployPackage(this.org.getUsername(), this.flags.outputdir);
      this.ux.stopSpinner(`done`);

      if (!this.flags.savesources) {
        await this.removeDir(this.flags.outputdir);
      }
    } catch (e) {
      this.ux.stopSpinner('error');
      this.formatError(e).map(msg => {
        this.ux.log(msg)
      });
    }

    return {orgId: this.org.getOrgId()};
  }

  private getPackageHierarchy(pkgName, pkgDirs) {
    const pkg = pkgDirs.find(p => p.package === pkgName);

    if (!pkg) {
      const err = new core.SfdxError(`The ${pkgName} package doesn't exist`);
      err.actions = ['Verify the package name exists in the sfdx-project.json file.'];
      throw err;
    }

    const pkgs = [{
      name: pkg.package,
      path: pkg.path
    }];

    return (pkg.dependencies && pkg.dependencies.length)
      ? pkg.dependencies.reduce((accPaths, parentPkg) => [...accPaths, ...this.getPackageHierarchy(parentPkg.package, pkgDirs)], pkgs)
      : pkgs;
  }

  private async convertPackages(pkgs, outputdir) {
    await core.fs.mkdirp(outputdir);

    for (const pkg of pkgs) {
      this.ux.startSpinner(`Convert ${pkg.name} (${pkg.path}) package`);
      const {stderr} = await exec(`sfdx force:source:convert -d ${outputdir} -r ${pkg.path}`);

      if (stderr) {
        this.ux.error(stderr);
        this.ux.stopSpinner('error');
      } else {
        this.ux.stopSpinner('done');
      }
    }
  }

  private async generatePackageXmlFile(outputDir, apiVersion) {
    await sgp({
      src: outputDir,
      apiVersion: apiVersion || '44.0',
      output: outputDir,
      indent: '    '
    }, this.ux.log);
  }

  private async deployPackage(username, sourcesPath) {
    const packageXmlPath = sourcesPath.lastIndexOf('/') === sourcesPath.length - 1 ? sourcesPath : sourcesPath + '/';
    const {stdout, stderr} = await exec(`sfdx force:source:deploy -x ${packageXmlPath}package.xml -u ${username}`);
    this.ux.log(stdout);
    this.ux.error(stderr);
  }

  private async removeDir(path) {
    await exec(`rm -rf ${path}`);
  }
}
